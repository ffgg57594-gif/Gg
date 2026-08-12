# Presenton LLM Gateway

بوابة **OpenAI-compatible** عشان تستخدم سكريبت الشات بتاعك كـ **Base URL** مباشر في [presenton.ai](https://presenton.ai).

السكريبت الأصلي بيعمل `POST` على دالة Supabase. Presenton مش بيستدعي الـ URL ده كده:

1. **GET** `{base}/models` عشان يظهر قائمة الموديلات
2. **POST** `{base}/chat/completions` عشان يولّد العرض

البوابة دي بتعمل الاتنين، وبتحوّل الـ stream لرد OpenAI عادي لو Presenton طلب JSON.

## Base URL اللي هتستخدمه

بعد ما المشروع يترفع على Vercel:

```text
https://YOUR-APP.vercel.app/v1
```

| الحقل في Presenton | القيمة |
| --- | --- |
| OpenAI Compatible URL | `https://YOUR-APP.vercel.app/v1` |
| OpenAI Compatible API Key | `presenton` (أي قيمة) |
| Model | `google/gemini-2.5-pro` |

### على موقع presenton.ai

1. Settings → Custom / OpenAI Compatible
2. الصق الـ Base URL
3. اكتب أي API key
4. Check for available models
5. اختار `google/gemini-2.5-pro`

### لو بتشغّل Presenton بنفسك

```bash
LLM=custom
CUSTOM_LLM_URL=https://YOUR-APP.vercel.app/v1
CUSTOM_LLM_API_KEY=presenton
CUSTOM_MODEL=google/gemini-2.5-pro
```

## Deploy على Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/ffgg57594-gif/Gg/tree/arena/019ff695-gg&project-name=presenton-llm-gateway&repository-name=presenton-llm-gateway)

أو من الجهاز:

```bash
npm i -g vercel
vercel
```

مفيش Environment Variables مطلوبة. الافتراضي متظبط على:

```text
UPSTREAM_URL=https://qcpujeurnkbvwlvmylyx.supabase.co/functions/v1/chat
DEFAULT_MODEL=google/gemini-2.5-pro
```

اختياري:

| المتغير | الوظيفة |
| --- | --- |
| `UPSTREAM_URL` | Endpoint الشات الأصلي |
| `DEFAULT_MODEL` | الموديل الافتراضي |
| `MODELS` | قائمة موديلات مفصولة بفاصلة لـ `GET /v1/models` |
| `PROXY_API_KEY` | لو اتظبط، Presenton لازم يستخدم نفس الـ key |

خطة Vercel المجانية بتحدد مدة الدالة بحوالي 60 ثانية. لو العروض بتقطع، ارفع الخطة أو زوّد `maxDuration`.

## Endpoints

| Method | Path | الاستخدام |
| --- | --- | --- |
| `GET` | `/v1` | Health / معلومات البوابة |
| `GET` | `/v1/models` | اللي Presenton بيطلبه وهو بيفتح الموديلات |
| `POST` | `/v1/chat/completions` | نفس شكل OpenAI |
| `GET` | `/v1/chat/completions?prompt=...` | نفس الشات بـ GET |

```bash
curl -s https://YOUR-APP.vercel.app/v1/models

curl -s "https://YOUR-APP.vercel.app/v1/chat/completions?prompt=Tell%20me%20a%20joke"

curl -s https://YOUR-APP.vercel.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"google/gemini-2.5-pro","messages":[{"role":"user","content":"Tell me a joke"}]}'
```

## تشغيل محلي

```bash
node server.js
```

بعدها افتح `http://localhost:3000` — الصفحة هتعرض الـ Base URL جاهز للنسخ.

```bash
npm test
```
