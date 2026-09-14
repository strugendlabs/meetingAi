import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { ExportBlock } from "./exportData";

/** Renders blocks into a docx Document with semantic heading levels. */
export function buildExportDocx(blocks: ExportBlock[]): Document {
  const children: Paragraph[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "title":
        children.push(new Paragraph({ text: block.text, heading: HeadingLevel.TITLE }));
        break;
      case "meta":
        children.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, italics: true, color: "666666" })],
            spacing: { after: 200 },
          }),
        );
        break;
      case "heading":
        children.push(
          new Paragraph({
            text: block.text,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 80 },
          }),
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ text: block.text, spacing: { after: 160 } }));
        break;
      case "bullet":
        children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }));
        break;
      case "checkbox":
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: block.checked ? "☑ " : "☐ " }),
              new TextRun({ text: block.text, strike: block.checked }),
            ],
          }),
        );
        break;
      case "transcriptLine":
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${block.speaker}  `, bold: true }),
              new TextRun({ text: `${block.timestamp}  `, color: "999999" }),
              new TextRun({ text: block.text }),
            ],
            spacing: { after: 40 },
          }),
        );
        break;
      case "translationLine":
        children.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, italics: true })],
            indent: { left: 360 },
            spacing: { after: 80 },
          }),
        );
        break;
    }
  }

  return new Document({ sections: [{ children }] });
}

export function docxToBlob(doc: Document): Promise<Blob> {
  return Packer.toBlob(doc);
}
