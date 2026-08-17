# NutriGuard Egypt — Graduation Discussion Guide

## الرسالة الأساسية

NutriGuard ليس Chatbot عامًا يختلق أرقامًا غذائية. هو مساعد متخصص في الأكل المصري، يفصل بين ثلاث مسؤوليات:

1. **RAG** يسترجع الوصفة أو الإرشاد الأقرب من قاعدة معرفة مصرية محددة.
2. **حاسبة حتمية** تحسب القيم الغذائية من المكونات والكميات بدل أن يقدّرها النموذج اللغوي.
3. **طبقة أمان ومصادر** تعرض الأدلة، تميّز القيم المفقودة، وترفض الادعاء عندما لا تتوفر بيانات كافية.

نسخة المناقشة تعمل محليًا دون مفاتيح خارجية. تحتوي قاعدة العرض على 215 وصفة مصرية معتمدة داخل نطاق مشروع التخرج، و169 مرجعًا غذائيًا للمكونات، و219 وثيقة مفهرسة للاسترجاع. حالة الوصفات `verified` للاستخدام الأكاديمي داخل NutriGuard، مع بقاء القيم الغذائية تقديرية وعدم اعتبار اعتماد المشروع شهادة طبية إنتاجية.

## عرض مقترح في 8 دقائق

### الدقيقة 0–1: المشكلة

- نماذج المحادثة العامة قد تخلط بين أكلات متشابهة أو تخترع قيمة غذائية.
- الوصفات المصرية لها أسماء وتهجئات وكميات وحالات طهي محلية.
- القرار الغذائي يحتاج رقمًا قابلًا للتتبع، وليس إجابة لغوية فقط.

### الدقيقة 1–2: الحل

اعرض التدفق التالي:

`سؤال المستخدم → فحص الأمان → RAG → الوصفة/الإرشاد → الحاسبة الحتمية → إجابة مع المصدر`

اشرح أن النموذج لا ينفذ العمليات الحسابية من ذاكرته. الحساب يتم في أداة مستقلة ومختبرة، بينما RAG مسؤول عن العثور على السياق المناسب.

### الدقيقة 2–4: العرض الحي

استخدم الأسئلة بهذا الترتيب:

1. `طريقة عمل الطعمية المصرية ومكوناتها`
2. `كام صوديوم في الكشري لكل 100 جرام؟`
3. `قارن بين الكشري والملوخية على نفس الأساس`
4. `ما إرشادات منظمة الصحة العالمية للصوديوم؟`

بعد كل إجابة افتح قسم **كيف وصلنا للإجابة؟** وأشر إلى:

- الوثائق المسترجعة ودرجة التشابه.
- المعرّف الثابت للوصفة.
- الأداة المستخدمة.
- أساس القياس: لكل حصة أو لكل 100 جرام.
- حالة المراجعة والمصدر.

### الدقيقة 4–5: جودة البيانات

- القيم المفقودة تظل `null` ولا تتحول إلى صفر.
- تم اكتشاف وتصحيح مضاعفة زيت القلي في 22 وصفة داخل مسار Demo؛ يحسب الزيت الممتص بدل جمع زيت القلي الكامل مرتين.
- الناتج قابل لإعادة الإنتاج: تشغيل إعداد Demo أكثر من مرة ينتج الملفات نفسها byte-for-byte.

### الدقيقة 5–6: الاختبارات والأمان

- اختبارات وحدات وتكامل تغطي الحساب، الاسترجاع، API، قاعدة البيانات، الأمان، والانحدارات.
- حماية من الطلبات الكبيرة، Content-Type الخاطئ، Origins غير المسموح بها، وRate Limiting.
- سياسة محتوى طبي: المشروع مساعد معلومات غذائية وليس بديلًا للطبيب.
- مسار Demo ممنوع برمجيًا خارج بيئتي development/test.

### الدقيقة 6–7: تقييم RAG

اعرض النتائج كما هي:

| المقياس | نتيجة Demo المحلية |
|---|---:|
| Recall@1 | 57.41% |
| Recall@3 | 85.19% |
| MRR@5 | 70.68% |
| الأسئلة التجريبية | 80 |
| المرتبطة بإجابة متوقعة واضحة | 54 |

التفسير: الإجابة الصحيحة تظهر ضمن أول ثلاث نتائج في 85.19% من الأسئلة المرتبطة. هذا Benchmark محلي synthetic لا يُستخدم لاختيار نموذج إنتاجي نهائي، لكنه يثبت أن خط التقييم موجود ويمكن إعادة تشغيله.

### الدقيقة 7–8: الخلاصة والتوسع

- نسخة التخرج تثبت المنتج End-to-End محليًا.
- هندسة الإنتاج موجودة لـ PostgreSQL وQdrant ومزود Embeddings مع إعدادات تفشل بأمان.
- الانتقال إلى منتج صحي حقيقي يحتاج مراجعة بشرية للبيانات، Pilot حقيقي، حسابات استضافة، واعتمادات مالكي القرار.

## أسئلة لجنة متوقعة

### لماذا استخدمتم RAG بدل Fine-tuning؟

لأن بيانات الوصفات والإرشادات تتغير ويجب إظهار مصدرها. RAG يسمح بتحديث المعرفة وإرجاع الوثيقة المستخدمة دون إعادة تدريب نموذج. ويمكن لاحقًا استخدام Fine-tuning لتحسين الأسلوب، لكن ليس لتخزين الحقائق الغذائية.

### ما الفرق بين RAG والحاسبة؟

RAG يجد السياق المناسب. الحاسبة تحول المكونات والكميات إلى نتائج رقمية بطريقة حتمية. فصل الاثنين يمنع النموذج اللغوي من اختراع الحساب.

### لماذا تستخدمون Qdrant في الإنتاج بينما Demo يعمل بدونه؟

Demo يستخدم مخزنًا متجهيًا داخل الذاكرة ليعمل بلا حسابات أو أسرار أثناء المناقشة. Qdrant مناسب للإنتاج لأنه يحفظ المتجهات، يدعم الفلاتر والتوسع والنسخ الاحتياطية. كلاهما يطبق الواجهة البرمجية نفسها.

### هل النتائج دقيقة طبيًا؟

هي تقديرات هندسية في نسخة التخرج وليست تشخيصًا أو توصية علاجية. الدقة الإنتاجية تتطلب مراجعة مختص تغذية للمكونات والكميات وحالات الطهي والمصادر.

### ماذا يحدث لو كانت قيمة أحد المكونات غير موجودة؟

تبقى القيمة `null` وتظهر النتيجة كجزئية عند الحاجة. لا نستخدم صفرًا لأنه يعني “صفر معروف”، بينما `null` يعني “غير معروف”.

### كيف تمنعون الـ Hallucination؟

- الأرقام تأتي من أدوات حتمية لا من نص يولده النموذج.
- الإجابات تعتمد على وثائق مسترجعة وتعرض provenance.
- توجد حالات `no_result` و`clarification` بدل الإجابة القسرية.
- اختبارات adversarial تتحقق من محاولات تجاوز التعليمات أو تزوير المصدر.

### لماذا لا تربطون جميع الأسئلة الثمانين؟

بعض الأسئلة عامة أو تحمل أسماء لا تحدد وصفة واحدة بثقة. تركها دون Expected ID أفضل من اختراع Ground Truth خاطئ، وهو قرار يحافظ على صدق التقييم.

### هل النظام جاهز للإنتاج؟

المنتج الهندسي ونسخة العرض جاهزان لمشروع التخرج. الإطلاق الصحي العام يحتاج بيانات معتمدة، Benchmark بأسئلة حقيقية بموافقة أصحابها، بنية استضافة، وموافقات بشرية وتشغيلية. المشروع لا يدعي أن هذه الموافقات حدثت.

## قائمة ما قبل المناقشة

1. استخدم Node.js بالإصدار المحدد في `package.json`.
2. نفذ `npm install` مسبقًا، ولا تعتمد على إنترنت اللجنة.
3. نفذ `npm run demo:prepare` ثم `npm run dev:web`.
4. افتح `http://127.0.0.1:3000` وجرّب الأسئلة الأربعة.
5. احتفظ بصورة أو تسجيل قصير للواجهة كخطة بديلة.
6. أغلق البرامج الثقيلة والإشعارات قبل العرض.
7. لا تقل “100% accurate” أو “production approved”. استخدم “deterministic, traceable, graduation-ready”.

## ربط Backend الحقيقي في العرض

مسار العرض يستخدم بيانات الوصفات المحلية المعتمدة للبحث والاختيار، ويمكنه تسجيل الاختيار المؤكد في Backend كـ Custom Meal. لتفعيل الربط:

1. يرسل الـFrontend الـaccess token قصير العمر في `Authorization: Bearer <token>` مع كل طلب إلى `/api/v1/chat`.
2. يمرر AI Adapter التوكن داخل نفس الطلب فقط إلى NutriGuard Backend؛ لا يخزنه في singleton ولا يكتبه في السجلات، ولا يستقبل refresh token.
3. فعّل `NUTRIGUARD_BACKEND_TRACKING_ENABLED=true`. الاتصالات الموثقة تتطلب HTTPS افتراضيًا.
4. استخدم `https://nutriguard.runasp.net` كعنوان Backend. خيار `NUTRIGUARD_ALLOW_INSECURE_BACKEND_HTTP` يظل مغلقًا، ولا يُستخدم إلا مع Backend محلي داخل جهاز المطور.

التسجيل الحقيقي يستخدم نداءً واحدًا إلى `POST /api/Tracking/custom-meals/batch`. يرسل الـAI كل اختيارات الملخص المؤكد معًا، ويضع نفس `pending_operation_id` في هيدر `Idempotency-Key`. الـBackend هو مصدر الحقيقة للذرّية ومنع التكرار الدائم: أول طلب صحيح يرجع `applied: true` ومعرّفات السجلات، وإعادة نفس الطلب ترجع `applied: false` و`reason: "already_logged"`، أما إعادة المفتاح مع محتوى مختلف فترجع `409`. لا يُستخدم التسجيل المتتابع إلا كمسار توافق داخلي عند حقن data source قديم في الاختبارات؛ الـruntime الحقيقي يفضّل الـbatch دائمًا.

قراءة البروفايل والأهداف والقواعد والملخص اليومي تتم من `GET /api/HealthProfile` و`GET /api/Nutrition/targets` و`GET /api/Nutrition/user-rules` و`GET /api/Tracking/summary/{date}`. أي رقم مفقود يظل `null` ولا يتحول إلى صفر أو تقدير.

لا تضع بيانات دخول أو JWT في Git أو ملفات التوثيق أو المحادثات. استخدم تسجيل الدخول في الـFrontend، واترك refresh token بين الـFrontend وBackend فقط.

## أوامر التحقق الآلي قبل العرض

```bash
npm run demo:prepare
npm run type-check
npm run lint
npm test
npm run build
npm run docs:check
```

## Frontend, CORS, and direct API smoke test

The local graduation runtime allows browser requests from `http://localhost:5173` and `https://nutri-guard-frontend.vercel.app`. The production host must set `ALLOWED_ORIGINS=https://nutri-guard-frontend.vercel.app`; configured origins are canonicalized, so an accidental trailing slash does not change the match.

Before debugging the frontend, call the AI service directly:

```http
POST /api/v1/chat
Content-Type: application/json
Authorization: Bearer <short-lived Backend access token>

{
  "message": "Suggest three meals for me today",
  "language": "en"
}
```

Do not send a conversation `context` on the first message. With a valid Backend token, the AI reads the current nutrition target and dated daily summary, calculates the remaining calories without inventing missing values, and uses that remainder for the meal plan. Without a usable token or complete Backend numbers, it asks for a calorie target instead of falsely reporting that no recipe exists. The refresh token remains between the frontend and Backend and must never be sent to the AI service.

### Meal-count language and recipe gram weights

- Meal-plan counts accept ASCII digits, Arabic-Indic digits, English words from `one` through `ten`, and common Arabic/Egyptian forms such as `ثلاث`, `ثلاثة`, `تلاتة`, `وجبة واحدة`, and `وجبتين`.
- Counts outside the supported range of 1–10, including negative, decimal, zero, or words such as `eleven`, return an explicit clarification; they are never silently converted to three meals.
- Generic requests such as `Suggest any Egyptian meal`, `Recommend me any Egyptian food`, `اقترح أي وجبة مصرية`, and `رشحلي أي أكل مصري` select one deterministic verified option using the health-first ranking. A calorie, nutrient, category, pantry, or exclusion constraint takes precedence over the generic `any/أي` fallback.
- English polite/free-form variants such as `Could you recommend a meal?`, `Surprise me with an Egyptian dish`, `Pick something Egyptian to eat`, and `Any Egyptian meal is fine` use the same deterministic policy. `A couple of meals` means exactly two. Ambiguous ranges (`2 or 3 meals`, `a few meals`) and likely number typos (`tree meals`) require clarification; the Agent never silently turns them into three meals.
- `GET /api/Nutrition/targets` is an authenticated Backend endpoint. The current Swagger contract exposes it and an unauthenticated request correctly returns `401`. For the graduation test account, an authenticated request currently returns `404` with `Health profile is incomplete.` even though `GET /api/HealthProfile` returns `200`; therefore this `404` is a domain result for an incomplete target-calculation profile, not a missing API route. The AI Adapter may read target fields from the dated summary as a compatibility fallback, while missing numbers remain unknown and are never converted to zero.
- Recipe details and nutrition responses expose every recorded ingredient as canonical grams for the full recipe. Recommendations expose every ingredient as grams scaled to the selected serving or calorie-sized portion.
- Ingredient grams represent input weights. The displayed cooked serving weight can differ from their sum because the recorded nutrition calculation applies edible-portion and cooking-yield factors. The API states the basis in `ingredientWeightBasis` rather than implying that both weights must be equal.

## جملة ختامية مقترحة

> NutriGuard يحوّل سؤالًا باللهجة المصرية إلى نتيجة غذائية قابلة للتفسير: يجد المعرفة المناسبة، يحسب خارج النموذج اللغوي، ويعرض الدليل وحدود الثقة. لذلك هو نظام قابل للمراجعة والتطوير، وليس مجرد واجهة Chatbot.
