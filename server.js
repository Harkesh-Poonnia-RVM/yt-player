require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { google } = require("googleapis");

const PORT = 3000;
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");
const SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];

if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error(
    "Missing credentials.json. See README instructions in the chat for how to create it.",
  );
  process.exit(1);
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
        `Missing environment variable "${envKey}" referenced in credentials.json.`,
      );
      process.exit(1);
    }
    return envValue;
  }
  return value;
}

const credentials = resolveEnvPlaceholders(
  JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8")),
);
const { client_id, client_secret, redirect_uris } =
  credentials.web || credentials.installed;
const redirectUri =
  (redirect_uris && redirect_uris[0]) ||
  `http://localhost:${PORT}/oauth2callback`;

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirectUri,
);

// Load token if it already exists, so we don't have to re-auth every run.
if (fs.existsSync(TOKEN_PATH)) {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2Client.setCredentials(token);
}

// Persist refreshed tokens whenever the client refreshes them.
oauth2Client.on("tokens", (tokens) => {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"))
    : {};
  const merged = { ...existing, ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
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
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
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

    // Find the authenticated user's channel and its uploads playlist.
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

    // Get the uploaded videos from that playlist.
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

    // Fetch privacyStatus and clean snippet data directly from videos.list.
    const videosResp = await youtube.videos.list({
      part: ["snippet", "status"],
      id: videoIds,
    });

    const videos = videosResp.data.items.map((v) => ({
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

app.listen(PORT, () => {
  console.log(`YouTube private player running at http://localhost:${PORT}`);
});
