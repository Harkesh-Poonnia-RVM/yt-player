require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { google } = require("googleapis");

const PORT = process.env.PORT || 3000;
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

// For Vercel: store token in memory instead of file
let tokenCache = {};

// Load credentials from environment variable on Vercel
function getCredentials() {
  if (process.env.YOUTUBE_CREDENTIALS) {
    return JSON.parse(process.env.YOUTUBE_CREDENTIALS);
  }
  if (fs.existsSync(CREDENTIALS_PATH)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  }
  throw new Error("Missing YouTube credentials");
}

// Load token from environment variable on Vercel (filesystem there is read-only)
function getInitialToken() {
  if (process.env.YOUTUBE_TOKEN) {
    try {
      return JSON.parse(process.env.YOUTUBE_TOKEN);
    } catch (err) {
      console.error("Could not parse YOUTUBE_TOKEN env var:", err.message);
      return null;
    }
  }
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    } catch (err) {
      console.log("Could not load token file");
    }
  }
  return null;
}

function resolveEnvPlaceholders(value) {
  if (Array.isArray(value)) {
    return value.map(resolveEnvPlaceholders);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnvPlaceholders(v)]),
    );
  }
  if (typeof value === "string" && value.startsWith("process.env.")) {
    const envKey = value.slice("process.env.".length);
    const envValue = process.env[envKey];
    if (!envValue) {
      console.error(
        `Missing environment variable "${envKey}" referenced in credentials.`,
      );
      process.exit(1);
    }
    return envValue;
  }
  return value;
}

const credentials = resolveEnvPlaceholders(getCredentials());
const { client_id, client_secret } =
  credentials.web || credentials.installed;

// Use Vercel URL for OAuth2 callback
const redirectUri = process.env.REDIRECT_URI

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirectUri,
);

// Load token from env var (Vercel) or file (local)
const initialToken = getInitialToken();
if (initialToken) {
  tokenCache = initialToken;
  oauth2Client.setCredentials(tokenCache);
}

// Persist refreshed tokens
oauth2Client.on("tokens", (tokens) => {
  tokenCache = { ...tokenCache, ...tokens };
  if (!process.env.VERCEL) {
    // Save to file locally; filesystem on Vercel is read-only.
    // On Vercel, update the YOUTUBE_TOKEN env var manually if the
    // refresh token ever changes (it normally won't).
    try {
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenCache, null, 2));
    } catch (err) {
      console.log("Token file write skipped");
    }
  }
});

function isAuthenticated() {
  const creds = oauth2Client.credentials;
  return !!(creds && (creds.access_token || creds.refresh_token));
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/auth/youtube", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    tokenCache = tokens;
    if (process.env.VERCEL) {
      // Filesystem is read-only on Vercel; the token only lives for this
      // invocation. Log it so it can be copied into the YOUTUBE_TOKEN env var.
      console.log(
        "New token issued. Set this as the YOUTUBE_TOKEN env var on Vercel to persist it:",
        JSON.stringify(tokens),
      );
    } else {
      try {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      } catch (err) {
        console.log("Token persistence skipped");
      }
    }
    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

app.get("/api/auth-status", (req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

app.get("/api/videos", async (req, res) => {
  if (!isAuthenticated()) {
    return res
      .status(401)
      .json({ error: "Not authenticated. Visit /auth/youtube first." });
  }

  try {
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });

    const channelResp = await youtube.channels.list({
      part: ["contentDetails"],
      mine: true,
    });

    const channel = channelResp.data.items && channelResp.data.items[0];
    if (!channel) {
      return res
        .status(404)
        .json({ error: "No YouTube channel found for this account." });
    }

    const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;

    const playlistResp = await youtube.playlistItems.list({
      part: ["snippet"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
    });

    const videoIds = playlistResp.data.items.map(
      (item) => item.snippet.resourceId.videoId,
    );

    if (videoIds.length === 0) {
      return res.json({ videos: [] });
    }

    const videosResp = await youtube.videos.list({
      part: ["snippet", "status"],
      id: videoIds,
    });

    const videos = videosResp.data.items
      .filter((v) => v.status.privacyStatus !== "public")
      .map((v) => ({
        id: v.id,
        title: v.snippet.title,
        thumbnail:
          (v.snippet.thumbnails.medium && v.snippet.thumbnails.medium.url) ||
          (v.snippet.thumbnails.default && v.snippet.thumbnails.default.url),
        privacyStatus: v.status.privacyStatus,
      }));

    res.json({ videos });
  } catch (err) {
    console.error("Error fetching videos:", err);
    res.status(500).json({ error: err.message });
  }
});

// Export for Vercel Serverless Functions
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Local development
  app.listen(PORT, () => {
    console.log(`YouTube private player running at http://localhost:${PORT}`);
  });
}