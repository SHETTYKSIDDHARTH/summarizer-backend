import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory chat sessions
const chats = {};

// Root endpoint for health check
app.get("/", (req, res) => {
  res.json({ 
    message: "Meeting Transcript Summarizer API",
    status: "OK", 
    timestamp: new Date().toISOString(),
    endpoints: [
      "GET /api/health",
      "POST /api/start-session", 
      "POST /api/summarize",
      "GET /api/test-gemini"
    ]
  });
});

// Start a new session with transcript
app.post("/api/start-session", async (req, res) => {
  try {
    const { transcript, userInstruction } = req.body;

    if (!transcript || transcript.trim() === "") {
      return res.status(400).json({ error: "Transcript is required" });
    }

    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: `You are an AI assistant specialized in analyzing and summarizing meeting transcripts. Your core objective is to transform unstructured meeting or call notes into clear, accurate, and professional summaries.
STRICT RULES:
-Refuse and do not answer any request that is not:
  1) Uploading and analyzing a transcript
  2) Generating a structured summary
  3) Refining/editing the summary
  4) Preparing an email-ready version of the summary
- Always refuse unrelated queries with:
  {
    "initial_bullet_summary": ["This request is out of scope."],
    "user_customized_summary": "Only transcript summarization and email-ready outputs are supported.",
    "clarifications_or_notes": ["Provide a transcript and (optionally) an instruction."]
  }
IMPORTANT:Dont answer any other request from the user other than 
IMPORTANT: Always respond with a valid JSON object containing these three keys:
{
  "initial_bullet_summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
  "user_customized_summary": "formatted summary text here",
  "clarifications_or_notes": ["note 1 if any", "note 2 if any"] or []
}

Core Requirements:
- Create 3-5 concise bullet points covering key topics, decisions, and action items
- Format the summary according to user instructions (executive summary, action items only, etc.)
- Use clear, professional language
- Include clarifications only if something is unclear or missing
- Always respond with valid JSON - no extra text outside the JSON object`
    });

    const userPrompt = `Here is the meeting transcript:
${transcript}

User instruction: ${userInstruction || "Generate a clear, concise summary with bullet points and detailed summary"}

Please analyze this transcript and provide your response as a JSON object with the three required keys.`;

    const chat = model.startChat({
      history: []
    });

    const result = await chat.sendMessage(userPrompt);

    let rawResponse = result.response.text();
    console.log("Raw AI Response:", rawResponse);
    
    rawResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let jsonResponse;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = JSON.parse(jsonMatch[0]);
      } else {
        jsonResponse = {
          initial_bullet_summary: ["Summary could not be parsed in structured format"],
          user_customized_summary: rawResponse,
          clarifications_or_notes: ["AI response was not in expected JSON format"]
        };
      }
      
      if (!jsonResponse.initial_bullet_summary || !jsonResponse.user_customized_summary || !Array.isArray(jsonResponse.initial_bullet_summary)) {
        throw new Error("Invalid JSON structure");
      }
      
      if (!Array.isArray(jsonResponse.clarifications_or_notes)) {
        jsonResponse.clarifications_or_notes = [];
      }
      
    } catch (e) {
      console.error("JSON parse error:", e);
      console.error("Raw response:", rawResponse);
      jsonResponse = {
        initial_bullet_summary: ["Error parsing AI response - please try again"],
        user_customized_summary: rawResponse.substring(0, 500) + "...",
        clarifications_or_notes: ["Could not parse structured response from AI"]
      };
    }

    const sessionId = Date.now().toString();
    chats[sessionId] = chat;

    res.json({ sessionId, summary: jsonResponse });
  } catch (err) {
    console.error("Error in start-session:", err);
    res.status(500).json({ error: "Error starting session: " + err.message });
  }
});

// Refine summary or handle user instructions
app.post("/api/summarize", async (req, res) => {
  try {
    const { sessionId, prompt } = req.body;
    
    if (!sessionId || !chats[sessionId]) {
      return res.status(400).json({ error: "Invalid or expired sessionId" });
    }
    
    if (!prompt || prompt.trim() === "") {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const chat = chats[sessionId];

    const result = await chat.sendMessage(prompt + "\n\nPlease provide your response as a valid JSON object with initial_bullet_summary, user_customized_summary, and clarifications_or_notes keys.");

    let rawResponse = result.response.text();
    console.log("Raw AI Response:", rawResponse);
    
    rawResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();

    let summary;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        summary = JSON.parse(jsonMatch[0]);
      } else {
        summary = {
          initial_bullet_summary: ["Refinement completed"],
          user_customized_summary: rawResponse,
          clarifications_or_notes: []
        };
      }
      
      if (!summary.initial_bullet_summary || !summary.user_customized_summary || !Array.isArray(summary.initial_bullet_summary)) {
        throw new Error("Invalid JSON structure");
      }
      
      if (!Array.isArray(summary.clarifications_or_notes)) {
        summary.clarifications_or_notes = [];
      }
      
    } catch (e) {
      console.error("JSON parse error in refine:", e);
      summary = {
        initial_bullet_summary: ["Error parsing refined response"],
        user_customized_summary: rawResponse.substring(0, 500) + "...",
        clarifications_or_notes: ["Could not parse structured response from AI"]
      };
    }

    res.json({ summary });
  } catch (err) {
    console.error("Error in summarize:", err);
    res.status(500).json({ error: "Error generating summary: " + err.message });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    env: {
      gemini_key_set: !!process.env.GEMINI_API_KEY,
    }
  });
});

// Test Gemini API endpoint
app.get("/api/test-gemini", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent("Say hello in JSON format with a message key");
    
    res.json({ 
      success: true, 
      response: result.response.text(),
      message: "Gemini API is working correctly" 
    });
  } catch (err) {
    console.error("Gemini test error:", err);
    res.status(500).json({ 
      error: "Gemini API test failed", 
      details: err.message 
    });
  }
});

// Get active sessions count
app.get("/api/sessions", (req, res) => {
  res.json({ 
    active_sessions: Object.keys(chats).length,
    session_ids: Object.keys(chats)
  });
});

// Clean up old sessions (run every hour)
const cleanupSessions = () => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  let cleanedCount = 0;
  
  Object.keys(chats).forEach(sessionId => {
    if (parseInt(sessionId) < oneHourAgo) {
      delete chats[sessionId];
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`Cleaned up ${cleanedCount} old sessions`);
  }
};

// Manual cleanup endpoint
app.post("/api/cleanup-sessions", (req, res) => {
  const beforeCount = Object.keys(chats).length;
  cleanupSessions();
  const afterCount = Object.keys(chats).length;
  
  res.json({
    message: "Session cleanup completed",
    sessions_before: beforeCount,
    sessions_after: afterCount,
    cleaned: beforeCount - afterCount
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ 
    error: "Internal server error", 
    message: err.message 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found",
    message: `The endpoint ${req.method} ${req.path} was not found`,
    available_endpoints: [
      "GET /",
      "GET /api/health",
      "POST /api/start-session", 
      "POST /api/summarize",
      "GET /api/test-gemini",
      "GET /api/sessions",
      "POST /api/cleanup-sessions"
    ]
  });
});

// For Vercel, we need to export the app as the default export
export default app;