// MeetingAI Windows system-audio sidecar.
//
// Captures every process except MeetingAI's process tree using the Windows
// application-loopback API (Windows build 20348+). On older Windows 10 builds,
// it falls back to endpoint loopback capture.
//
// stdout contract: [u32 little-endian byte length][PCM16 LE mono 16 kHz]
// stderr contract: one JSON status object per line

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <io.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <objidl.h>
#include <propidl.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kFrameBytes = 8000;  // 250 ms at 16 kHz, mono PCM16.

std::string json_escape(const std::string& value) {
    std::ostringstream out;
    for (const unsigned char ch : value) {
        switch (ch) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (ch < 0x20) {
                    out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<unsigned int>(ch);
                } else {
                    out << ch;
                }
        }
    }
    return out.str();
}

std::string hresult_message(const char* action, const HRESULT hr) {
    std::ostringstream out;
    out << action << " failed (HRESULT 0x" << std::hex << std::uppercase
        << static_cast<unsigned long>(hr) << ")";
    return out.str();
}

void emit_status(const char* event, const std::string& message = {}) {
    std::cerr << "{\"event\":\"" << event << "\"";
    if (!message.empty()) {
        std::cerr << ",\"message\":\"" << json_escape(message) << "\"";
    }
    std::cerr << "}" << std::endl;
}

template <typename T>
void release_com(T*& value) {
    if (value != nullptr) {
        value->Release();
        value = nullptr;
    }
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler,
                                public IAgileObject {
public:
    ActivationHandler() : completed_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}

    virtual ~ActivationHandler() {
        release_com(audio_client_);
        if (completed_ != nullptr) {
            CloseHandle(completed_);
        }
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
        if (object == nullptr) return E_POINTER;
        *object = nullptr;
        if (iid == __uuidof(IUnknown) ||
            iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (iid == __uuidof(IAgileObject)) {
            *object = static_cast<IAgileObject*>(this);
        } else {
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++references_;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = --references_;
        if (remaining == 0) delete this;
        return remaining;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(
        IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT activation_result = E_UNEXPECTED;
        IUnknown* activated = nullptr;
        result_ = operation->GetActivateResult(&activation_result, &activated);
        if (SUCCEEDED(result_)) result_ = activation_result;
        if (SUCCEEDED(result_) && activated != nullptr) {
            result_ = activated->QueryInterface(
                __uuidof(IAudioClient), reinterpret_cast<void**>(&audio_client_));
        }
        release_com(activated);
        SetEvent(completed_);
        return S_OK;
    }

    HRESULT wait_and_take(IAudioClient** client) {
        if (client == nullptr) return E_POINTER;
        *client = nullptr;
        if (completed_ == nullptr) return HRESULT_FROM_WIN32(GetLastError());
        const DWORD wait_result = WaitForSingleObject(completed_, 15000);
        if (wait_result != WAIT_OBJECT_0) {
            return wait_result == WAIT_TIMEOUT
                ? HRESULT_FROM_WIN32(WAIT_TIMEOUT)
                : HRESULT_FROM_WIN32(GetLastError());
        }
        if (FAILED(result_)) return result_;
        *client = audio_client_;
        audio_client_ = nullptr;
        return S_OK;
    }

private:
    std::atomic<ULONG> references_{1};
    HANDLE completed_ = nullptr;
    HRESULT result_ = E_UNEXPECTED;
    IAudioClient* audio_client_ = nullptr;
};

struct AudioSession {
    IAudioClient* audio_client = nullptr;
    IAudioCaptureClient* capture_client = nullptr;
    HANDLE sample_ready = nullptr;

    ~AudioSession() {
        if (audio_client != nullptr) audio_client->Stop();
        release_com(capture_client);
        release_com(audio_client);
        if (sample_ready != nullptr) CloseHandle(sample_ready);
    }
};

WAVEFORMATEX capture_format() {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 1;
    format.nSamplesPerSec = 16000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    return format;
}

HRESULT activate_process_loopback(const DWORD excluded_pid, IAudioClient** client) {
    if (client == nullptr) return E_POINTER;
    *client = nullptr;

    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    params.ProcessLoopbackParams.TargetProcessId = excluded_pid;

    PROPVARIANT activation{};
    activation.vt = VT_BLOB;
    activation.blob.cbSize = static_cast<ULONG>(sizeof(params));
    activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    auto* handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* operation = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activation,
        handler,
        &operation);
    if (SUCCEEDED(hr)) {
        hr = handler->wait_and_take(client);
    }
    release_com(operation);
    handler->Release();
    return hr;
}

HRESULT activate_endpoint_loopback(IAudioClient** client) {
    if (client == nullptr) return E_POINTER;
    *client = nullptr;

    IMMDeviceEnumerator* enumerator = nullptr;
    IMMDevice* device = nullptr;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(&enumerator));
    if (SUCCEEDED(hr)) {
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
    }
    if (SUCCEEDED(hr)) {
        hr = device->Activate(
            __uuidof(IAudioClient),
            CLSCTX_ALL,
            nullptr,
            reinterpret_cast<void**>(client));
    }
    release_com(device);
    release_com(enumerator);
    return hr;
}

HRESULT initialize_session(const DWORD excluded_pid, AudioSession& session) {
    HRESULT hr = activate_process_loopback(excluded_pid, &session.audio_client);
    if (FAILED(hr)) {
        emit_status(
            "warning",
            "Process-excluding audio capture is unavailable on this Windows build; "
            "using endpoint loopback capture.");
        hr = activate_endpoint_loopback(&session.audio_client);
    }
    if (FAILED(hr)) return hr;

    WAVEFORMATEX format = capture_format();
    const DWORD stream_flags =
        AUDCLNT_STREAMFLAGS_LOOPBACK |
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    hr = session.audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        stream_flags,
        0,
        0,
        &format,
        nullptr);
    if (FAILED(hr)) return hr;

    session.sample_ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (session.sample_ready == nullptr) return HRESULT_FROM_WIN32(GetLastError());

    hr = session.audio_client->SetEventHandle(session.sample_ready);
    if (FAILED(hr)) return hr;

    return session.audio_client->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(&session.capture_client));
}

bool write_frame(const std::uint8_t* bytes, const std::size_t size) {
    if (size == 0 || size > UINT32_MAX) return size == 0;
    const std::uint32_t length = static_cast<std::uint32_t>(size);
    const unsigned char prefix[4] = {
        static_cast<unsigned char>(length & 0xFF),
        static_cast<unsigned char>((length >> 8) & 0xFF),
        static_cast<unsigned char>((length >> 16) & 0xFF),
        static_cast<unsigned char>((length >> 24) & 0xFF),
    };
    return std::fwrite(prefix, 1, sizeof(prefix), stdout) == sizeof(prefix) &&
           std::fwrite(bytes, 1, size, stdout) == size &&
           std::fflush(stdout) == 0;
}

bool flush_complete_frames(std::vector<std::uint8_t>& pending) {
    std::size_t consumed = 0;
    while (pending.size() - consumed >= kFrameBytes) {
        if (!write_frame(pending.data() + consumed, kFrameBytes)) return false;
        consumed += kFrameBytes;
    }
    if (consumed > 0) {
        pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(consumed));
    }
    return true;
}

int capture(const DWORD excluded_pid, const bool check_only) {
    AudioSession session;
    const HRESULT init = initialize_session(excluded_pid, session);
    if (FAILED(init)) {
        emit_status("error", hresult_message("system audio initialization", init));
        return 1;
    }
    if (check_only) return 0;

    const HRESULT started = session.audio_client->Start();
    if (FAILED(started)) {
        emit_status("error", hresult_message("system audio start", started));
        return 1;
    }
    emit_status("started");

    std::vector<std::uint8_t> pending;
    pending.reserve(kFrameBytes * 2);

    for (;;) {
        const DWORD wait_result = WaitForSingleObject(session.sample_ready, 2000);
        if (wait_result == WAIT_TIMEOUT) continue;
        if (wait_result != WAIT_OBJECT_0) {
            emit_status("error", "waiting for a system-audio sample failed");
            return 1;
        }

        UINT32 next_frames = 0;
        HRESULT hr = session.capture_client->GetNextPacketSize(&next_frames);
        while (SUCCEEDED(hr) && next_frames > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = session.capture_client->GetBuffer(
                &data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            const std::size_t byte_count = static_cast<std::size_t>(frames) * 2;
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr) {
                pending.insert(pending.end(), byte_count, 0);
            } else {
                pending.insert(pending.end(), data, data + byte_count);
            }
            session.capture_client->ReleaseBuffer(frames);

            if (!flush_complete_frames(pending)) {
                emit_status("error", "writing system audio to the parent process failed");
                return 1;
            }
            hr = session.capture_client->GetNextPacketSize(&next_frames);
        }
        if (FAILED(hr)) {
            emit_status("error", hresult_message("reading system audio", hr));
            return 1;
        }
    }
}

bool parse_pid(const char* value, DWORD& pid) {
    if (value == nullptr || *value == '\0') return false;
    char* end = nullptr;
    const unsigned long parsed = std::strtoul(value, &end, 10);
    if (end == value || *end != '\0' || parsed == 0) return false;
    pid = static_cast<DWORD>(parsed);
    return true;
}

void print_usage() {
    std::cout
        << "system-audio - MeetingAI Windows system-audio capture sidecar\n\n"
        << "Usage:\n"
        << "  system-audio --exclude-pid <pid>\n"
        << "  system-audio --check [--exclude-pid <pid>]\n"
        << "  system-audio --version\n"
        << "  system-audio --help\n";
}

}  // namespace

int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    std::ios::sync_with_stdio(false);

    bool check_only = false;
    DWORD excluded_pid = GetCurrentProcessId();
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") {
            print_usage();
            return 0;
        }
        if (arg == "--version") {
            std::cout << "system-audio 0.1.0\n";
            return 0;
        }
        if (arg == "--check") {
            check_only = true;
            continue;
        }
        if (arg == "--exclude-pid" && i + 1 < argc) {
            if (!parse_pid(argv[++i], excluded_pid)) {
                emit_status("error", "invalid --exclude-pid value");
                return 64;
            }
            continue;
        }
        emit_status("error", "unknown or incomplete argument: " + arg);
        print_usage();
        return 64;
    }

    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(com)) {
        emit_status("error", hresult_message("COM initialization", com));
        return 1;
    }
    const int result = capture(excluded_pid, check_only);
    CoUninitialize();
    return result;
}
