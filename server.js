require("dotenv").config();

const express = require("express");
const { google } = require("googleapis");

const app = express();

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.client_id;
const CLIENT_SECRET = process.env.client_secret;
const REDIRECT_URI = process.env.REDIRECT_URI;

const ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const REFRESH_TOKEN_EXPIRES_IN =
  process.env.REFRESH_TOKEN_EXPIRES_IN;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
];

if (!CLIENT_ID) {
  console.error(
    "Missing client_id in environment variables"
  );
  process.exit(1);
}

if (!CLIENT_SECRET) {
  console.error(
    "Missing client_secret in environment variables"
  );
  process.exit(1);
}

if (!REDIRECT_URI) {
  console.error(
    "Missing REDIRECT_URI in environment variables"
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

if (ACCESS_TOKEN || REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
  });

  console.log(
    "YouTube token loaded from environment variables."
  );

  if (REFRESH_TOKEN_EXPIRES_IN) {
    console.log(
      "Refresh token expiration:",
      `${REFRESH_TOKEN_EXPIRES_IN} seconds`
    );
  }
} else {
  console.log(
    "No YouTube tokens found. YouTube authentication required."
  );
}

oauth2Client.on("tokens", (tokens) => {
  console.log("YouTube OAuth token refreshed.");

  if (tokens.access_token) {
    oauth2Client.setCredentials({
      ...oauth2Client.credentials,
      ...tokens,
    });
  }
});

function isAuthenticated() {
  const credentials = oauth2Client.credentials;

  return Boolean(
    credentials?.access_token ||
      credentials?.refresh_token
  );
}

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "YouTube backend is running",
  });
});

app.get("/auth/youtube", (req, res) => {
  try {
    const authUrl =
      oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });

    console.log(
      "Redirecting to Google OAuth..."
    );

    res.redirect(authUrl);
  } catch (error) {
    console.error(
      "Failed to generate OAuth URL:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to start YouTube authentication",
    });
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send(`
        <h1>Authentication Failed</h1>
        <p>Missing authorization code.</p>
      `);
    }

    console.log(
      "Authorization code received."
    );

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    console.log(
      "YouTube authentication successful."
    );

    console.log(
      "OAuth tokens received."
    );

    console.log(
      "Access token received:",
      Boolean(tokens.access_token)
    );

    console.log(
      "Refresh token received:",
      Boolean(tokens.refresh_token)
    );

    if (tokens.refresh_token_expires_in) {
      console.log(
        "Refresh token expires in:",
        `${tokens.refresh_token_expires_in} seconds`
      );
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>YouTube Connected</title>
        </head>

        <body style="
          font-family: Arial;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
        ">
          <div style="text-align: center;">
            <h1>YouTube Connected Successfully ✅</h1>
            <p>Your YouTube account is now connected.</p>
            <p>You can close this window.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(
      "OAuth callback error:",
      error.response?.data ||
        error.message ||
        error
    );

    res.status(500).send(`
      <h1>YouTube Authentication Failed</h1>
      <pre>${error.message}</pre>
    `);
  }
});

app.get("/api/auth-status", (req, res) => {
  res.json({
    authenticated: isAuthenticated(),
    refreshTokenConfigured: Boolean(
      REFRESH_TOKEN
    ),
    refreshTokenExpiresIn:
      REFRESH_TOKEN_EXPIRES_IN || null,
  });
});

app.get("/api/videos", async (req, res) => {
  try {
    if (!isAuthenticated()) {
      return res.status(401).json({
        success: false,
        message:
          "YouTube account is not authenticated",
      });
    }

    const youtube = google.youtube({
      version: "v3",
      auth: oauth2Client,
    });

    const channelResponse =
      await youtube.channels.list({
        part: ["contentDetails"],
        mine: true,
      });

    if (
      !channelResponse.data.items ||
      channelResponse.data.items.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message: "No YouTube channel found",
      });
    }

    const uploadsPlaylistId =
      channelResponse.data.items[0]
        .contentDetails
        .relatedPlaylists
        .uploads;

    const playlistResponse =
      await youtube.playlistItems.list({
        part: [
          "snippet",
          "contentDetails",
        ],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
      });

    const playlistItems =
      playlistResponse.data.items || [];

    if (playlistItems.length === 0) {
      return res.json({
        success: true,
        count: 0,
        videos: [],
      });
    }

    const videoIds = playlistItems
      .map(
        item =>
          item.contentDetails?.videoId
      )
      .filter(Boolean);

    const videosResponse =
      await youtube.videos.list({
        part: [
          "snippet",
          "status",
          "contentDetails",
        ],
        id: videoIds,
      });

    const videos =
      videosResponse.data.items || [];

    const unlistedVideos = videos.filter(
      video =>
        video.status?.privacyStatus ===
        "unlisted"
    );

    console.log(
      `Found ${videos.length} total videos`
    );

    console.log(
      `Found ${unlistedVideos.length} unlisted videos`
    );

    const formattedVideos =
      unlistedVideos.map(video => ({
        id: video.id,

        title:
          video.snippet?.title || "",

        description:
          video.snippet?.description || "",

        thumbnail:
          video.snippet?.thumbnails?.high
            ?.url ||
          video.snippet?.thumbnails?.medium
            ?.url ||
          video.snippet?.thumbnails?.default
            ?.url ||
          null,

        privacyStatus:
          video.status?.privacyStatus ||
          null,

        publishedAt:
          video.snippet?.publishedAt ||
          null,

        channelTitle:
          video.snippet?.channelTitle ||
          null,

        duration:
          video.contentDetails?.duration ||
          null,
      }));

    res.json({
      success: true,
      count: formattedVideos.length,
      videos: formattedVideos,
    });
  } catch (error) {
    console.error(
      "Failed to fetch YouTube videos:",
      error.response?.data ||
        error.message ||
        error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to fetch YouTube videos",
      error:
        error.response?.data ||
        error.message ||
        "Unknown error",
    });
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "YouTube Player Backend",

    endpoints: {
      health: "/api/health",
      auth: "/auth/youtube",
      authStatus: "/api/auth-status",
      videos: "/api/videos",
    },
  });
});

app.listen(PORT, () => {
  console.log("");
  console.log(
    "======================================"
  );
  console.log("YouTube backend running");
  console.log(`http://localhost:${PORT}`);
  console.log(
    "======================================"
  );
  console.log("");
});