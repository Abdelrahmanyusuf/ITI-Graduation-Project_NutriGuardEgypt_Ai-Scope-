import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';

async function processWHOGuidelines(pdfPath) {
    const dataBuffer = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: dataBuffer });

    try {
        const pdfData = await parser.getText();

        // تقسيم النص إلى فقرات/Chunks بناءً على النقاط الأساسية
        const text = pdfData.text;
        const rawChunks = text.split(/\n\s*\n/); // التقسيم مع كل سطر فارغ

        const formattedChunks = rawChunks
            .map(chunk => chunk.trim())
            .filter(chunk => chunk.length > 50) // إستبعاد الأسطر القصيرة جداً
            .map((chunkText, index) => {
                return {
                    id: `who_guideline_${index + 1}`,
                    text: chunkText,
                    metadata: {
                        source: "WHO Guidelines 2026",
                        language: "en"
                    }
                };
            });

        console.log(`✅ تم تقطيع ملف WHO إلى ${formattedChunks.length} Chunks بنجاح!`);
        fs.writeFileSync('who_chunks.json', JSON.stringify(formattedChunks, null, 2));
    } finally {
        await parser.destroy();
    }
}

await processWHOGuidelines('WHO Guidelines.pdf');
