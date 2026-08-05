import fs from 'fs';
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { DynamicTool } from "@langchain/core/tools";
import { Embeddings } from "@langchain/core/embeddings";
// نستدعي المكتبة الأساسية مباشرة بدون وسيط LangChain
import { pipeline } from "@xenova/transformers";

// 1. بناء Class صغير يعمل كجسر مستقر بين الموديل المحلي و LangChain
class MyLocalEmbeddings extends Embeddings {
    constructor() {
        super({});
        // تحميل الموديل المحلي الخفيف
        this.extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    }

    // دالة لتحويل نصوص الملفات إلى أرقام (Vectors)
    async embedDocuments(texts) {
        const extractor = await this.extractorPromise;
        const embeddings = [];
        for (const text of texts) {
            const output = await extractor(text, { pooling: "mean", normalize: true });
            embeddings.push(Array.from(output.data));
        }
        return embeddings;
    }

    // دالة لتحويل سؤال المستخدم إلى أرقام
    async embedQuery(text) {
        const extractor = await this.extractorPromise;
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return Array.from(output.data); // تحويل الناتج لمصفوفة عادية
    }
}

export async function getGuidelinesTool() {
    // 2. قراءة الملف اللي جهزناه
    const rawData = fs.readFileSync('combined_guidelines.json', 'utf-8');
    const chunks = JSON.parse(rawData);

    // 3. تحويل البيانات لصفحات (Documents)
    const docs = chunks.map(chunk => new Document({
        pageContent: chunk.text,
        metadata: chunk.metadata
    }));

    // 4. تشغيل الموديل المحلي الخاص بنا (أول مرة فقط هيحمل الموديل من الإنترنت)
    console.log("⏳ جاري تجهيز الموديل المحلي (MyLocalEmbeddings)...");
    const localEmbeddings = new MyLocalEmbeddings();

    // 5. تخزين البيانات في الذاكرة
    const vectorStore = await MemoryVectorStore.fromDocuments(docs, localEmbeddings);
    
    // 6. إنشاء محرك البحث (Retriever)
    const retriever = vectorStore.asRetriever({ k: 3 });

    // 7. صناعة الأداة (Tool)
    return new DynamicTool({
        name: "health_guidelines_search",
        description: "استخدم هذه الأداة للبحث عن إرشادات منظمة الصحة العالمية أو معلومات الهرم الغذائي. أدخل استعلامك باللغة الإنجليزية.",
        func: async (query) => {
            console.log(`🔍 جاري البحث في الإرشادات عن: ${query}`);
            const results = await retriever.invoke(query);
            return results.map(r => r.pageContent).join("\n\n---\n\n");
        },
    });
}

// ==========================================
// 💡 تجربة الأداة بشكل منفصل (Testing)
// ==========================================
async function testTool() {
    const tool = await getGuidelinesTool();
    const result = await tool.invoke("What is the recommended serving for vegetables and fruits?");
    console.log("✅ نتيجة البحث:\n", result);
}

// testTool();
