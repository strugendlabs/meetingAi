import pdfMake from "pdfmake/build/pdfmake";
import type { Content, ContentText, TDocumentDefinitions } from "pdfmake/interfaces";
import latinRegular from "../../assets/fonts/NotoSans-Regular.ttf?url";
import latinBold from "../../assets/fonts/NotoSans-Bold.ttf?url";
import hindiRegular from "../../assets/fonts/Hind-Regular.ttf?url";
import hindiBold from "../../assets/fonts/Hind-Bold.ttf?url";
import type { ExportBlock } from "./exportData";

const FONT_FILES = { latinRegular, latinBold, hindiRegular, hindiBold };
let fontsReady: Promise<void> | null = null;

/** Fonts ship with the app: exporting works offline and uploads no meeting text. */
async function loadFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const entries = await Promise.all(Object.entries(FONT_FILES).map(async ([name, url]) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Couldn't load PDF font (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return [name, btoa(binary)] as const;
      }));
      pdfMake.addVirtualFileSystem(Object.fromEntries(entries));
      pdfMake.addFonts({
        NotoSans: { normal: "latinRegular", bold: "latinBold", italics: "latinRegular", bolditalics: "latinBold" },
        Hind: { normal: "hindiRegular", bold: "hindiBold", italics: "hindiRegular", bolditalics: "hindiBold" },
      });
    })().catch((error) => { fontsReady = null; throw error; });
  }
  return fontsReady;
}

/** Keep Indic conjuncts and combining marks together for fontkit shaping. */
function textRuns(text: string): ContentText[] {
  return (text.match(/[\u0900-\u097f\ua8e0-\ua8ff\u1cd0-\u1cff\u200c\u200d]+|[^\u0900-\u097f\ua8e0-\ua8ff\u1cd0-\u1cff\u200c\u200d]+/gu) ?? [""])
    .map((part) => ({ text: part, font: /[\u0900-\u097f]/u.test(part) ? "Hind" : "NotoSans" }));
}

/** A searchable PDF with embedded Unicode fonts and native Indic shaping. */
export function buildPdfDefinition(blocks: ExportBlock[]): TDocumentDefinitions {
  const content: Content[] = [];
  for (const block of blocks) {
    const text = textRuns(block.text);
    switch (block.kind) {
      case "title": content.push({ text, fontSize: 23, bold: true, color: "#171717", margin: [0, 0, 0, 8] }); break;
      case "meta": content.push({ text, fontSize: 9, color: "#737373", margin: [0, 0, 0, 22] }); break;
      case "heading": content.push({ text, fontSize: 12, bold: true, color: "#4f46e5", margin: [0, 16, 0, 9], headlineLevel: 1 }); break;
      case "paragraph": content.push({ text, margin: [0, 0, 0, 8] }); break;
      case "bullet": content.push({ columns: [{ text: "•", width: 14, color: "#4f46e5" }, { text }], margin: [0, 0, 0, 5] }); break;
      case "checkbox": content.push({
        columns: [{ text: block.checked ? "[x]" : "[ ]", width: 22, color: "#737373" }, { text }], margin: [0, 0, 0, 6],
      }); break;
      case "transcriptLine":
        // Repeating table headers keep speaker/time attached to the words,
        // including long utterances that continue onto the next page.
        content.push({
          table: {
            widths: ["*"], headerRows: 1,
            // pdfmake cannot keep a row taller than a page unbroken. Let
            // lengthy / multiline utterances flow with repeated headers.
            keepWithHeaderRows: block.text.length <= 1200 && block.text.split(/\r\n|\n|\r/).length <= 12 ? 1 : 0,
            body: [
            [{ text: [{ text: block.speaker, bold: true, color: block.speaker === "Me" ? "#4f46e5" : "#404040" }, { text: `   ${block.timestamp}`, color: "#737373" }], fontSize: 9 }],
            [{ text }],
          ] },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 3 },
          margin: [0, 9, 0, 7],
        });
        break;
      case "translationLine": content.push({ text, fontSize: 10, color: "#666666", margin: [12, 0, 0, 8] }); break;
    }
  }
  return {
    info: { title: blocks.find((b) => b.kind === "title")?.text ?? "Meeting transcript", creator: "MeetingAI" },
    pageSize: "A4",
    pageMargins: [48, 48, 48, 52],
    defaultStyle: { font: "NotoSans", fontSize: 11, lineHeight: 1.35, color: "#262626" },
    content,
    footer: (page, pages) => ({ columns: [
      { text: "MeetingAI", color: "#a3a3a3" },
      { text: `${page} / ${pages}`, alignment: "right", color: "#a3a3a3" },
    ], fontSize: 8, margin: [48, 18, 48, 0] }),
    pageBreakBefore: (node, container) => Boolean(node.headlineLevel) && container.getFollowingNodesOnPage().length === 0,
  };
}

export async function renderExportPdf(blocks: ExportBlock[]): Promise<Blob> {
  await loadFonts();
  return pdfMake.createPdf(buildPdfDefinition(blocks)).getBlob();
}
