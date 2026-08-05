import { ChatOpenAI } from "@langchain/openai";
import { loadEnvFile } from "node:process";
import { getGuidelinesTool } from './Guidelines_Rag.js';

try {
    loadEnvFile();
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is required. Add it to your .env file.');
}

async function runAgent() {
    console.log("⚙️ جاري تحميل أدوات NutriGuard...");
    const guidelinesTool = await getGuidelinesTool();

    // 1. إعداد الموديل
    const llm = new ChatOpenAI({
        modelName: "openai/gpt-4o-mini", 
        temperature: 0, 
        apiKey: openRouterApiKey,
        configuration: {
            baseURL: "https://openrouter.ai/api/v1", 
        }
    });

    // 2. تعريف الموديل بالأدوات المتاحة (بدون AgentExecutor المعقد)
    const llmWithTools = llm.bindTools([guidelinesTool]);

    // 3. إعداد سياق المحادثة الأساسي
    const messages = [
        ["system", `أنت مساعد صحي مصري اسمك "NutriGuard_Ai". مهمتك تقديم نصائح غذائية للمصريين.
            - تحدث دائماً باللغة العربية (العامية المصرية بأسلوب محترم وودود).
            - استخدم الأدوات المتاحة (Tools) للبحث عن المعلومات الطبية وإرشادات منظمة الصحة العالمية.
            - لا تخترع أي أرقام أو إرشادات من عندك أبداً. إذا لم تجد الإجابة في الأدوات، قل "معنديش معلومة أكيدة عن ده للأسف".
            - قم بصياغة نتائج البحث المعقدة إلى كلام بسيط ومفهوم للمستخدم العادي.`
        ],
        ["human", "أنا باكل خضار وفاكهة كتير، هو المفروض أكل قد إيه في اليوم حسب منظمة الصحة؟"]
    ];

    console.log("✅ الـ Agent جاهز للاستخدام! جاري توجيه السؤال...");
    console.log(`\n👨‍🦱 المستخدم: ${messages[1][1]}`);

    try {
        // الخطوة الأولى: نسأل الموديل (هل محتاج يبحث ولا هيرد علطول؟)
        const aiResponse = await llmWithTools.invoke(messages);

        // لو الموديل قرر يستخدم أداة البحث
        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
            
            // بنضيف رد الموديل للمحادثة عشان السياق يفضل متصل
            messages.push(aiResponse);

            // بنلف على الأدوات اللي الموديل طلبها (ممكن يطلب يبحث أكتر من مرة)
            for (const toolCall of aiResponse.tool_calls) {
                // الأداة بتاخد الـ input اللي الموديل فكر فيه
                const query = toolCall.args.input; 
                console.log(`\n🔍 جاري البحث في الإرشادات عن: ${query}`);

                // تشغيل الأداة فعلياً
                const toolResult = await guidelinesTool.invoke(query);

                // ✨ هنا الحل الجذري: بنبعت النتيجة لـ OpenRouter ومعاها الـ ID السليم ✨
                messages.push({
                    role: "tool",
                    content: toolResult,
                    tool_call_id: toolCall.id, 
                });
            }

            // الخطوة التانية: نبعت النتيجة النهائية للموديل عشان يصيغها بالعامية
            console.log("\n✍️ جاري صياغة الرد بالعامية المصرية...");
            const finalResponse = await llmWithTools.invoke(messages);
            console.log(`\n🤖 NutriGuard: ${finalResponse.content}\n`);
            
        } else {
            // لو الموديل عارف الإجابة بدون أدوات (ده نادراً بيحصل لأننا طالبين منه يبحث)
            console.log(`\n🤖 NutriGuard: ${aiResponse.content}\n`);
        }

    } catch (error) {
        console.error("❌ حصل مشكلة في الاتصال:", error.message);
    }
}

runAgent();
