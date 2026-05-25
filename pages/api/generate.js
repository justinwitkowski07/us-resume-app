import chromium from "@sparticuz/chromium";
import puppeteerCore from "puppeteer-core";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import * as jsonc from "jsonc-parser";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const getLocalChromeExecutablePath = () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // Common locations (best-effort). If none exist, puppeteer-core may still work via `channel`.
  const candidates = [];

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    const localAppData = process.env.LOCALAPPDATA;

    if (programFiles) {
      candidates.push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    if (programFilesX86) {
      candidates.push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    // linux
    candidates.push("/usr/bin/google-chrome");
    candidates.push("/usr/bin/google-chrome-stable");
    candidates.push("/usr/bin/chromium-browser");
    candidates.push("/usr/bin/chromium");
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return null;
};

// Move utility functions outside handler to avoid recreation
const calculateYears = (experience) => {
  if (!experience || experience.length === 0) return 0;
  
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    
    // Handle "Present"
    const trimmed = dateStr.trim();
    if (trimmed.toLowerCase() === "present") return new Date();
    
    // Handle "MM/YYYY" format (e.g., "12/2018", "07/2018")
    const mmYyyyMatch = trimmed.match(/^(\d{1,2})\/(\d{4})\s*$/);
    if (mmYyyyMatch) {
      const month = parseInt(mmYyyyMatch[1], 10) - 1; // JS months are 0-indexed
      const year = parseInt(mmYyyyMatch[2], 10);
      return new Date(year, month, 1); // First day of the month
    }
    
    // Handle other formats - try standard Date parsing
    const parsed = new Date(trimmed);
    
    // Check if date is valid
    if (isNaN(parsed.getTime())) {
      console.warn(`Failed to parse date: "${dateStr}"`);
      return null;
    }
    
    return parsed;
  };
  
  // Parse all dates and filter out invalid ones
  const validDates = experience
    .map(job => parseDate(job.start_date))
    .filter(date => date !== null);
  
  if (validDates.length === 0) {
    console.warn("No valid dates found in experience");
    return 0;
  }
  
  // Find earliest date
  const earliest = validDates.reduce((min, date) => {
    return date < min ? date : min;
  }, validDates[0]);
  
  const years = (new Date() - earliest) / (1000 * 60 * 60 * 24 * 365);
  return Math.max(8, Math.round(years));
};

// Cache template compilation
const templateCacheByPath = new Map();

const getTemplatePathForProfile = (profileName) => {
  const templatesDir = path.join(process.cwd(), "templates");
  const defaultTemplatePath = path.join(templatesDir, "Resume-1.html");

  if (typeof profileName !== "string" || !profileName.trim()) {
    return defaultTemplatePath;
  }

  return path.join(templatesDir, `${profileName.trim()}.html`);
};

const getTemplate = (profileName) => {
  let currentTemplatePath = getTemplatePathForProfile(profileName);
  const defaultTemplatePath = path.join(process.cwd(), "templates", "Resume-1.html");

  if (!fs.existsSync(currentTemplatePath)) {
    currentTemplatePath = defaultTemplatePath;
  }

  if (!templateCacheByPath.has(currentTemplatePath)) {
    const templateSource = fs.readFileSync(currentTemplatePath, "utf-8");

    // Register Handlebars helpers (idempotent, safe to call multiple times)
    Handlebars.registerHelper('formatKey', function(key) {
      return key;
    });

    Handlebars.registerHelper('join', function(array, separator) {
      if (Array.isArray(array)) {
        return array.join(separator);
      }
      return '';
    });

    templateCacheByPath.set(currentTemplatePath, Handlebars.compile(templateSource));
  }

  return templateCacheByPath.get(currentTemplatePath);
};

// Cache profile data in memory to avoid repeated file reads
const profileCache = new Map();

const loadProfile = (profileName) => {
  if (profileCache.has(profileName)) {
    return profileCache.get(profileName);
  }
  
  const profilePath = path.join(process.cwd(), "resumes", `${profileName}.json`);
  if (!fs.existsSync(profilePath)) {
    return null;
  }
  
  const profileData = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  profileCache.set(profileName, profileData);
  return profileData;
};

const extractJsonObject = (text) => {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
};

const escapeControlCharsInJsonStrings = (jsonText) => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      escaped = false;
      continue;
    }

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      result += ch;
      inString = false;
      continue;
    }

    if (ch === "\n") result += "\\n";
    else if (ch === "\r") continue;
    else if (ch === "\t") result += "\\t";
    else if (ch.charCodeAt(0) < 32) continue;
    else result += ch;
  }

  return result;
};

const tryParseResumeJson = (rawContent) => {
  let content = rawContent
    .replace(/```(?:json|javascript)?\s*/gi, "")
    .replace(/```\s*/g, "")
    .replace(/^(here is|here's|this is|the json is):?\s*/gi, "")
    .trim();

  const extracted = extractJsonObject(content);
  if (!extracted) {
    return { ok: false, error: "No JSON object found in response" };
  }

  const attempts = [
    extracted,
    extracted.replace(/,(\s*[}\]])/g, "$1").replace(/,\s*,/g, ","),
    escapeControlCharsInJsonStrings(extracted),
    escapeControlCharsInJsonStrings(
      extracted.replace(/,(\s*[}\]])/g, "$1").replace(/,\s*,/g, ",")
    ),
  ];

  for (const candidate of attempts) {
    try {
      return { ok: true, data: JSON.parse(candidate) };
    } catch {
      // continue
    }

    const jsoncErrors = [];
    const jsoncResult = jsonc.parse(candidate, jsoncErrors);
    if (jsoncErrors.length === 0 && jsoncResult !== undefined) {
      return { ok: true, data: jsoncResult };
    }
  }

  return { ok: false, error: "JSON parse failed after repair attempts" };
};

const normalizeResumeContent = (resumeContent) => {
  if (Array.isArray(resumeContent.summary)) {
    resumeContent.summary = resumeContent.summary.filter(Boolean).join(" ");
  } else if (typeof resumeContent.summary === "string") {
    resumeContent.summary = resumeContent.summary.replace(/\s+/g, " ").trim();
  }

  if (Array.isArray(resumeContent.experience)) {
    resumeContent.experience = resumeContent.experience.map((exp) => ({
      ...exp,
      details: Array.isArray(exp.details)
        ? exp.details.map((d) => String(d).replace(/\s+/g, " ").trim())
        : [],
    }));
  }

  return resumeContent;
};

// Call OpenAI with timeout & retries
async function callOpenAI(promptOrMessages, options = {}) {
  const {
    model = null,
    maxTokens = 8192,
    retries = 2,
    timeoutMs = 180000,
    jsonMode = false,
  } = options;
  let attemptsLeft = retries;
  while (attemptsLeft > 0) {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("Missing OPENAI_API_KEY");
      }

      // Build messages for OpenAI Chat Completions
      let messages = [];

      if (typeof promptOrMessages === "string") {
        messages = [{ role: "user", content: promptOrMessages }];
      } else if (Array.isArray(promptOrMessages)) {
        const systemMsg = promptOrMessages.find((msg) => msg.role === "system");
        if (systemMsg) {
          const systemContent = Array.isArray(systemMsg.content)
            ? systemMsg.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n")
            : systemMsg.content;
          messages.push({ role: "system", content: systemContent });
        }
        const rest = promptOrMessages
          .filter((msg) => msg.role !== "system")
          .map((msg) => ({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          }));
        messages.push(...rest);
      } else {
        messages = [{ role: "user", content: String(promptOrMessages) }];
      }

      const apiParams = {
        model: model || process.env.OPENAI_MODEL || "gpt-5-mini",
        max_completion_tokens: maxTokens,
        temperature: 1,
        messages,
      };

      if (jsonMode) {
        apiParams.response_format = { type: "json_object" };
      }

      const completion = await Promise.race([
        openai.chat.completions.create(apiParams),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("OpenAI request timed out")), timeoutMs)
        ),
      ]);

      // Normalize to a shape similar to Anthropic response for downstream code
      const choice = completion.choices?.[0];
      return {
        content: [{ type: "text", text: choice?.message?.content ?? "" }],
        stop_reason: choice?.finish_reason ?? "stop",
        usage: completion.usage
          ? { input_tokens: completion.usage.prompt_tokens, output_tokens: completion.usage.completion_tokens }
          : undefined,
        model: completion.model,
      };
    } catch (err) {
      attemptsLeft--;
      if (attemptsLeft === 0) throw err;
      console.log(`Retrying... (${attemptsLeft} attempts left)`);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    console.log("OpenAI config:", {
      hasApiKey: Boolean(process.env.OPENAI_API_KEY),
      apiKeyLength: process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 0,
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
    });

    const { profile, jd, company, role } = req.body;

    if (!profile) return res.status(400).send("Profile required");
    if (!jd) return res.status(400).send("Job description required");
    if (!company) return res.status(400).send("Company name required");
    if (!role) return res.status(400).send("Role name required");

    // Load profile JSON (using cache)
    console.log(`Loading profile: ${profile}`);
    const profileData = loadProfile(profile);
    
    if (!profileData) {
      return res.status(404).send(`Profile "${profile}" not found`);
    }

    const yearsOfExperience = Math.max(8, calculateYears(profileData.experience) - 1);

    // AI PROMPT: Realism-first ATS resume generation
    const prompt = `Realism-first ATS resume expert. Generate resume JSON: {"title":"...","summary":"...","skills":{...},"experience":[...]}

**OUTPUT: ONLY valid JSON, no markdown/explanations.**

**PROFILE:**
Candidate: ${profileData.name} | ${profileData.email} | ${profileData.phone} | ${profileData.location}
Experience: ${yearsOfExperience} years | Most Recent: ${profileData.experience[0]?.title || 'N/A'}

**WORK:**
${profileData.experience.map((job, idx) => {
  let workEntry = `${idx + 1}. ${job.company} | ${job.title || ''} | ${job.start_date} - ${job.end_date}`;
  if (job.details && job.details.length > 0) {
    workEntry += '\n   Details:\n' + job.details.map((detail, detailIdx) => `   - ${detail}`).join('\n');
  }
  return workEntry;
}).join('\n\n')}

**EDUCATION:**
${profileData.education.map(edu => `${edu.degree}, ${edu.school} (${edu.start_year}-${edu.end_year})`).join('\n')}

**JOB DESCRIPTION:**
${jd}

**INSTRUCTIONS (REALISM-FIRST ATS ENGINE)**

**1. DOMAIN KEYWORDS (CONTEXT-AWARE ONLY)**

Extract 8-15 relevant keywords from JD.

CORE RULE (IMPORTANT):
Domain keywords are NOT mandatory or universal.
Include ONLY IF:
- Supported by candidate experience OR
- Clearly implied by company domain OR
- Explicitly required by JD AND realistically align with role scope

VALID USAGE EXAMPLES:
- Identity/Security -> ONLY if backend/auth/system/security work exists
- OAuth2 / JWT -> ONLY if authentication systems are present
- GDPR / SOC2 -> ONLY if enterprise/regulatory systems exist
- HIPAA / FHIR -> ONLY if healthcare domain is explicitly relevant
- Data Governance -> ONLY if data-heavy systems exist

FORBIDDEN:
- injecting healthcare keywords into non-healthcare companies
- forcing compliance terms into generic SaaS roles
- keyword stuffing unrelated to experience

FALLBACK RULE:
If not supported, replace with neutral equivalents:
- "secure authentication systems"
- "data access controls"
- "privacy-aware system design"
- "regulated data handling (general)"

**2. TITLE (CAREER CONSISTENCY LOCK)**

Base Title: Most recent job title (first experience entry)

RULE:
Maintain ONE consistent engineering identity across entire resume.

STRICT RULE:
Do NOT transform candidate into different career paths unless explicitly supported by experience history.

Allowed adjustments ONLY:
- frontend <-> fullstack
- backend <-> API/backend specialist
- devops <-> infrastructure specialist

**3. SUMMARY (REALISTIC SENIOR NARRATIVE)**

Write exactly 5-6 complete sentences as one flowing paragraph. Each sentence should be rich and 15-25 words. Do NOT write short one-clause fragments.
SUMMARY JSON RULE: "summary" must be ONE single-line string (all sentences joined with spaces). Never put line breaks inside the summary value.

STRUCTURE (one full sentence each):
- Sentence 1: [Title] with ${yearsOfExperience}+ years of experience building [domain-specific systems] (e.g., scalable web and data systems)
- Sentence 2: Core expertise in 1-2 primary technologies, extended with how they were applied across real systems (backend/frontend/fullstack scope as appropriate)
- Sentence 3: Flagship achievement with metric, naming the business outcome and technical work (e.g., AI integrations, APIs, automation)
- Sentence 4: Secondary technical depth (data modeling, databases, pipelines, architecture) tied to scale or system type
- Sentence 5: Infrastructure/cloud or platform strengths with reliability/maintainability framing
- Sentence 6 (optional — use for 6-sentence summaries only): Leadership, Agile delivery, mentoring, and forward-looking focus aligned to JD (reliability, performance, automation, LLM/modern stack only if plausible)

STYLE (match this density and tone, adapt to candidate/JD):
"Senior Lead Software Engineer with 10+ years of experience building scalable web and data systems. Core expertise in Python and Vue.js with strong experience delivering production features across backend and frontend systems. Delivered AI-powered lead automation and API integrations that improved qualified lead conversion by 22%. Experienced in designing PostgreSQL data models and analytics pipelines for high-volume systems. Hands-on with AWS and Terraform to build reliable and maintainable cloud infrastructure. Proven technical leader in Agile teams, mentoring engineers and focused on system reliability, performance optimization, and automation using modern backend and LLM-based solutions."

RULES:
- Use connective phrasing: "with strong experience", "Experienced in", "Hands-on with", "Proven technical leader", "Focused on"
- Max 1-2 technical keywords per sentence; weave into natural prose, not lists
- 40% technical / 60% narrative balance
- NO keyword stacking or repeated buzzwords across sentences
- Mix impact levels naturally: small (10-20%), medium (20-50%), rare high (50%+)
- FORBIDDEN: choppy summaries like "Core expertise in X and Y." as a standalone tiny line

**4. SKILLS (REAL-WORLD STACK MODEL)**

60-80 skills across 5-8 categories

REALISM PRINCIPLES:
- 50-60% primary stack (real usage only)
- 30-40% adjacent/supporting skills
- 10% aspirational (ONLY if plausible)

STRICT RULES:
- No "everything engineer" syndrome
- No conflicting ecosystems (e.g., too many frameworks from unrelated stacks)
- No repeated keywords across categories
- Must match: job timeline, company type, industry maturity

**5. EXPERIENCE (REALISM-FIRST ENGINE)**

${profileData.experience.length} entries. Bullet count by seniority (most recent job = entry 1):

BULLET COUNT BY LEVEL:
- Recent senior-level roles (most recent 1-2 jobs; e.g., Senior, Lead, Principal, Staff, Architect): 6-8 bullets
- Mid-level roles (middle career; e.g., Engineer, Developer, ML Engineer without senior prefix): 5-7 bullets
- Early-level roles (oldest jobs; e.g., Analyst, Junior, Intern, first industry roles): 4-6 bullets

Use job title, dates, and position in work history to pick the correct range per entry.

CORE PRINCIPLE:
Experience must reflect: company scale, industry type, time period tech adoption, realistic seniority growth.

DETAIL-BASED BULLETS (CRITICAL):
1. Start from provided Details - For any job with "Details", derive bullets from those accomplishments (do not invent unrelated work).
2. Align to JD naturally - Tailor wording and emphasis to JD where authentic; never force unsupported keywords.
3. Maintain authenticity - Keep core accomplishments, seniority, and technologies from provided details.
4. If no details provided - Generate plausible bullets from job title, company, dates, and JD while staying realistic.

Each bullet should be rich and between 25-30 words.

STRUCTURE PER JOB:
- 1 system-level ownership bullet (ONLY if justified)
- 2-3 feature/engineering delivery bullets
- 2-3 optimization/maintenance/collaboration bullets

KEYWORD RULE:
- Max 1-2 JD keywords per bullet
- 30% bullets must NOT contain explicit keywords (implicit mapping allowed)

METRIC REALISM MODEL:
- 10-20% improvements -> common
- 20-50% improvements -> standard
- 50%+ improvements -> rare
- 2x-3x -> max 1-2 per entire resume

**6. TECHNOLOGY REALISM RULE (STRICT)**

Only use technologies that:
- existed during job timeframe
- were realistically adopted in that company type

If uncertain -> use generic alternatives instead of specific frameworks.

Technology release examples (verify against job dates):
- Angular: 2016 | React: 2013 | TypeScript: 2012 | Vue.js: 2014 | Next.js: 2016
- Docker: 2013 | Kubernetes: 2014 | AWS Lambda: 2014 | GraphQL: 2015
- Pre-2013 frontend: jQuery, Backbone.js, AngularJS 1.x | Pre-2013 backend: PHP, Java, .NET, Ruby on Rails

**7. COMPANY CONTEXT RULE (CRITICAL)**

Each company must influence output style:
- Enterprise (e.g., Nordstrom): governance, scale, compliance, reliability
- Mid-size SaaS: feature velocity, optimization, scaling
- Startup: ownership, rapid iteration, system building
- Early career roles: implementation, support, learning focus

**8. CAREER CONSISTENCY RULE**

Resume must represent ONE real human career.

**9. BULLET FORMAT**

Action Verb + Tech (valid for timeframe) + What + Impact + Metric

Verbs: Architected, Engineered, Designed, Built, Developed, Implemented, Optimized, Enhanced, Led, Spearheaded, Automated, Deployed

Avoid: Responsible for, Worked on

**10. ATS + REALISM CHECKLIST**

Before output:
- Each bullet is rich and between 25-30 words
- Resume reads like ONE consistent career
- No keyword injection without context
- No unrealistic stack inflation
- Metrics are varied and believable
- Company context is preserved
- Tech matches timeline realism
- Keywords are natural, not forced
- Balance exists between ATS and human readability

**OUTPUT (STRICT)**

Return ONLY one valid JSON object (no markdown). Required shape:
{"title":"...","summary":"Sentence 1. Sentence 2. Sentence 3.","skills":{"Category":["Skill1","Skill2"]},"experience":[{"title":"...","details":["bullet1","bullet2"]}]}

JSON RULES:
- "summary" is a single string on one line (sentences separated by spaces only, no \\n or line breaks in the value)
- Escape any double quotes inside string values as \\"
- No trailing commas
`;

    const callOptions = { jsonMode: true };
    const aiResponse = await callOpenAI(prompt, callOptions);
    
    // Log token usage to debug if we're hitting limits
    console.log("OpenAI API Response Metadata:");
    console.log("- Model:", aiResponse.model);
    const finishReason = aiResponse.stop_reason;
    console.log("- Stop reason:", finishReason);
    console.log("- Input tokens:", aiResponse.usage?.input_tokens);
    console.log("- Output tokens:", aiResponse.usage?.output_tokens);
    
    const getTextContent = (response) =>
      (response.content || []).map((part) => part?.text || "").join("").trim();

    let content = getTextContent(aiResponse);

    if (finishReason === "length") {
      console.error("⚠️ WARNING: OpenAI hit the max_tokens limit! Response may be truncated.");
    }

    // Check if AI is apologizing instead of returning JSON
    if (content.toLowerCase().startsWith("i'm sorry") || 
        content.toLowerCase().startsWith("i cannot") || 
        content.toLowerCase().startsWith("i apologize")) {
      console.error("AI is apologizing instead of returning JSON:", content.substring(0, 200));
      throw new Error("AI refused to generate resume. The prompt may be too complex. Please try again with a shorter job description or simpler requirements.");
    }
    
    let parsed = tryParseResumeJson(content);

    if (!parsed.ok) {
      console.log("🔄 Retrying with reduced requirements after JSON parse failure...");
      const concisePrompt = prompt
        .replace(/25-30 words/g, "25-30 words");

      const retryResponse = await callOpenAI(concisePrompt, callOptions);
      console.log("Retry stop reason:", retryResponse.stop_reason);
      content = getTextContent(retryResponse);
      parsed = tryParseResumeJson(content);
    }

    if (!parsed.ok) {
      console.error("=== JSON PARSE ERROR ===");
      console.error("Error:", parsed.error);
      console.error("Content length:", content.length);
      console.error("First 1000 chars:", content.substring(0, 1000));
      console.error("Last 500 chars:", content.substring(Math.max(0, content.length - 500)));
      throw new Error("AI did not return valid JSON format. Please try again.");
    }

    let resumeContent = normalizeResumeContent(parsed.data);
    
    // Validate required fields
    if (!resumeContent.title || !resumeContent.summary || !resumeContent.skills || !resumeContent.experience) {
      console.error("Missing required fields in AI response:", Object.keys(resumeContent));
      throw new Error("AI response missing required fields (title, summary, skills, or experience)");
    }

    console.log("✅ AI content generated successfully");
    console.log("Skills categories:", Object.keys(resumeContent.skills).length);
    console.log("Experience entries:", resumeContent.experience.length);
    
    // Debug: Check if experience has details
    resumeContent.experience.forEach((exp, idx) => {
      console.log(`Experience ${idx + 1}: ${exp.title || 'NO TITLE'} - Details count: ${exp.details?.length || 0}`);
      if (!exp.details || exp.details.length === 0) {
        console.error(`⚠️ WARNING: Experience entry ${idx + 1} has NO DETAILS!`);
      }
    });

    // Get cached template (compiled once per file, reused)
    const templateFn = getTemplate(profile);

    // Prepare data for template
    const templateData = {
      name: profileData.name,
      title: resumeContent.title,
      email: profileData.email,
      phone: profileData.phone,
      location: profileData.location,
      linkedin: profileData.linkedin,
      website: profileData.website,
      summary: resumeContent.summary,
      skills: resumeContent.skills,
      experience: profileData.experience.map((job, idx) => ({
        title: job.title || resumeContent.experience[idx]?.title || "Engineer",
        company: job.company,
        location: job.location,
        start_date: job.start_date,
        end_date: job.end_date,
        details: resumeContent.experience[idx]?.details || []
      })),
      education: profileData.education
    };

    // Render HTML
    const html = templateFn(templateData);
    console.log("HTML rendered from template");

    // Generate PDF with Puppeteer (optimized)
    // Check if running on Vercel (serverless environment)
    const isVercel = process.env.VERCEL || process.env.VERCEL_ENV;
    const isProduction = process.env.NODE_ENV === 'production';
    const isServerless = isVercel || isProduction;
    
    let browser;
    if (isServerless) {
      // Optimized chromium args for faster startup in serverless
      const optimizedArgs = [
        ...chromium.args,
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ];
      
      browser = await puppeteerCore.launch({
        args: optimizedArgs,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // Local dev: use your system Chrome/Chromium.
      // Set PUPPETEER_EXECUTABLE_PATH to your Chrome path if launch fails.
      const localExecutablePath = getLocalChromeExecutablePath();

      const launchOptions = {
        headless: "new",
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox'
        ]
      };

      if (localExecutablePath) {
        launchOptions.executablePath = localExecutablePath;
      } else {
        // puppeteer-core requires either executablePath or channel
        // This works when Chrome is installed and discoverable by Puppeteer.
        launchOptions.channel = "chrome";
      }

      browser = await puppeteerCore.launch(launchOptions);
    }

    const page = await browser.newPage();
    // Use 'load' instead of 'networkidle0' - much faster since we have no external resources
    await page.setContent(html, { waitUntil: "load" });
    
    // Generate PDF with optimized settings
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { 
        top: "15mm", 
        bottom: "15mm", 
        left: "0mm", 
        right: "0mm" 
      },
      preferCSSPageSize: false, // Faster rendering
    });
    
    await browser.close();

    console.log("PDF generated successfully!");
    
    // Generate filename from profile name, company and role
    // Move sanitize function outside to avoid recreation (though it's only called 3 times)
    const sanitizeFilename = (str) => str.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    const filename = `${sanitizeFilename(profileData.name)}_${sanitizeFilename(company)}_${sanitizeFilename(role)}.pdf`;
    
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(pdfBuffer);
    

  } catch (err) {
    console.error("PDF generation error:", err);

    const status = err?.status;
    const apiMessage = err?.error?.error?.message || err?.error?.message;

    if (status === 403) {
      return res
        .status(500)
        .send(
          "PDF generation failed: OpenAI returned 403 Forbidden (Request not allowed). " +
            "Check that OPENAI_API_KEY is set correctly for this environment and that your OpenAI account/key has access to the configured model. " +
            (apiMessage ? `Details: ${apiMessage}` : "")
        );
    }

    res.status(500).send("PDF generation failed: " + (apiMessage || err.message));
  }
}
