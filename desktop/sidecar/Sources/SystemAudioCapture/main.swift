// system-audio — MeetingAI system-audio capture sidecar.
//
// Contract (Task 4):
//   stdout: raw PCM16 LE mono 16 kHz frames, length-prefixed [u32 LE byte-length][payload]
//   stderr: JSON status lines: {"event":"started"} / {"event":"error","message":"..."}
//   flags:  --check → exit 0 if screen/audio-capture permission is granted, 2 if TCC denied

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - stderr JSON status lines

func emitStatus(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0A]))
}

func emitError(_ message: String) {
    emitStatus(["event": "error", "message": message])
}

// MARK: - stdout framing: [u32 LE byte-length][payload]

let stdoutHandle = FileHandle.standardOutput
let stdoutLock = NSLock()

func writeFrame(_ payload: Data) {
    guard !payload.isEmpty else { return }
    var len = UInt32(payload.count).littleEndian
    var frame = Data(bytes: &len, count: 4)
    frame.append(payload)
    stdoutLock.lock()
    stdoutHandle.write(frame)
    stdoutLock.unlock()
}

// MARK: - PCM conversion

/// Converts one AudioBuffer to PCM16 LE mono, taking channel 0 when multi-channel.
func pcm16Payload(buffer: AudioBuffer, asbd: AudioStreamBasicDescription) -> Data {
    guard let mData = buffer.mData else { return Data() }
    let byteCount = Int(buffer.mDataByteSize)
    let interleave = max(1, Int(buffer.mNumberChannels))
    let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0

    if isFloat && asbd.mBitsPerChannel == 32 {
        let sampleCount = byteCount / 4
        let frames = sampleCount / interleave
        guard frames > 0 else { return Data() }
        let floats = mData.bindMemory(to: Float32.self, capacity: sampleCount)
        var out = Data(count: frames * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            for f in 0..<frames {
                let v = max(-1.0, min(1.0, floats[f * interleave]))
                dst[f] = Int16(v * 32767.0)
            }
        }
        return out
    }

    if !isFloat && asbd.mBitsPerChannel == 16 {
        if interleave == 1 {
            return Data(bytes: mData, count: byteCount)
        }
        let sampleCount = byteCount / 2
        let frames = sampleCount / interleave
        guard frames > 0 else { return Data() }
        let ints = mData.bindMemory(to: Int16.self, capacity: sampleCount)
        var out = Data(count: frames * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            for f in 0..<frames {
                dst[f] = ints[f * interleave]
            }
        }
        return out
    }

    emitError("unsupported audio format: bitsPerChannel=\(asbd.mBitsPerChannel) isFloat=\(isFloat)")
    return Data()
}

// MARK: - Capture

final class AudioCapturer: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard
            let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee
        else { return }
        do {
            try sampleBuffer.withAudioBufferList { audioBufferList, _ in
                // Non-interleaved multi-channel arrives as one AudioBuffer per channel;
                // channel 0 (first buffer) is our mono source.
                guard let first = audioBufferList.first else { return }
                let payload = pcm16Payload(buffer: first, asbd: asbd)
                if !payload.isEmpty { writeFrame(payload) }
            }
        } catch {
            emitError("audio buffer read failed: \(error.localizedDescription)")
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitError("stream stopped: \(error.localizedDescription)")
        exit(1)
    }
}

// Kept alive for the life of the process.
var activeCapturer: AudioCapturer?
var activeStream: SCStream?

// MeetingAI's own bundle identifier (fixed — see tauri.conf.json `identifier`).
// This sidecar is a bare executable with no bundle of its own, so
// `excludesCurrentProcessAudio` (which only excludes audio rendered BY THIS
// PROCESS) does nothing useful here: the sidecar never plays audio — the
// translated voice is played by the MAIN app process via WebAudio. Without
// excluding that app explicitly, ScreenCaptureKit captures our own
// translated-voice playback right back as new "them" input, which Gemini
// then re-transcribes/re-translates — an audible feedback loop that also
// shows up as repeated/garbled transcript text.
let ownBundleID = "com.meetingai.desktop"

/// Builds the capture filter, excluding MeetingAI's own app when it's found
/// among the currently running (shareable) applications. Falls back to
/// capturing everything if our app isn't listed yet (e.g. a startup race) —
/// `excludesCurrentProcessAudio` below still helps in that narrow window.
func buildFilter(display: SCDisplay, applications: [SCRunningApplication]) -> SCContentFilter {
    if let ownApp = applications.first(where: { $0.bundleIdentifier == ownBundleID }) {
        return SCContentFilter(display: display, excludingApplications: [ownApp], exceptingWindows: [])
    }
    emitStatus(["event": "warning", "message": "own app not found in shareable content; self-audio exclusion inactive this run"])
    return SCContentFilter(display: display, excludingWindows: [])
}

func startCapture() {
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                emitError("no display available for capture")
                exit(1)
            }
            let filter = buildFilter(display: display, applications: content.applications)
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            // Defense-in-depth for the startup-race fallback above; the real
            // exclusion is the excludingApplications filter built above.
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 16000
            config.channelCount = 1
            // Minimal video config — no .screen output is attached, audio only.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.showsCursor = false

            let capturer = AudioCapturer()
            let stream = SCStream(filter: filter, configuration: config, delegate: capturer)
            try stream.addStreamOutput(
                capturer, type: .audio,
                sampleHandlerQueue: DispatchQueue(label: "com.meetingai.system-audio"))
            activeCapturer = capturer
            activeStream = stream
            try await stream.startCapture()
            emitStatus(["event": "started"])
        } catch {
            emitError("failed to start capture: \(error.localizedDescription)")
            exit(2)
        }
    }
    RunLoop.main.run()
}

func checkPermission() {
    Task {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            exit(0)
        } catch {
            emitError("permission denied: \(error.localizedDescription)")
            exit(2)
        }
    }
    RunLoop.main.run()
}

// MARK: - Entry

func printUsage() {
    let usage = """
    system-audio — MeetingAI system-audio capture sidecar

    Usage:
      system-audio           Capture PCM16 LE mono 16 kHz frames on stdout
      system-audio --check   Check Screen/System Audio Recording permission
      system-audio --version Print the sidecar version
      system-audio --help    Show this help
    """
    FileHandle.standardOutput.write(Data("\(usage)\n".utf8))
}

// Graceful shutdown on SIGINT/SIGTERM (parent normally SIGKILLs; this is belt-and-braces).
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGPIPE, SIG_IGN)
for sig in [SIGINT, SIGTERM] {
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        if let stream = activeStream {
            stream.stopCapture { _ in exit(0) }
        } else {
            exit(0)
        }
    }
    source.resume()
    // Intentionally leak the source so it stays alive for the process lifetime.
    _ = Unmanaged.passRetained(source)
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.isEmpty {
    startCapture()
} else if arguments == ["--check"] {
    checkPermission()
} else if arguments == ["--help"] || arguments == ["-h"] {
    printUsage()
} else if arguments == ["--version"] {
    print("system-audio 0.1.0")
} else {
    emitError("unknown arguments: \(arguments.joined(separator: " "))")
    printUsage()
    exit(64)
}
