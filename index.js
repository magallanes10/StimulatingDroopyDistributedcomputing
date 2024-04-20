const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const session = require('express-session');
const WebSocket = require('ws');

const app = express();
const port = 8080;

const publicDirectory = path.join(__dirname, "public");
const videosFilePath = path.join(__dirname, "videos.json");
const usersFilePath = path.join(publicDirectory, "users.json");
let videos = { videos: [] };
let users = { users: [] };

if (fs.existsSync(videosFilePath)) {
  const data = JSON.parse(fs.readFileSync(videosFilePath, "utf-8"));
  videos = data || { videos: [] };
}

if (fs.existsSync(usersFilePath)) {
  const data = JSON.parse(fs.readFileSync(usersFilePath, "utf-8"));
  users = data || { users: [] };
}

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true
}));

function saveUser(username, apiKey, ip) {
  if (!users) {
    users = { users: [] };
  }
  const user = { username, apiKey, ip };
  users.users.push(user);
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), "utf-8");

  // Notify connected clients about the updated user list
  broadcastUserList();
}

function broadcastUserList() {
  const userList = users.users.map(user => ({ username: user.username, apiKey: user.apiKey }));
  const message = JSON.stringify({ type: 'userList', data: userList });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

async function getDownloadLink(tikTokUrl) {
  try {
    const tikTokApiUrl = `https://www.tikwm.com/api/`;
    const response = await axios.post(tikTokApiUrl, { url: tikTokUrl });

    if (response.data && response.data.data && response.data.data.play) {
      return response.data.data.play;
    } else {
      console.error("TikTok API response:", response.data);
      return null;
    }
  } catch (error) {
    console.error("Error in TikTok API request:", error);
    return null;
  }
}

const tikTokLinkRegex = /^https:\/\/(?:www\.)?tiktok\.com\/(?:@[\w\d-]+\/video\/(\d+)|(@[\w\d-]+)?\/video\/(\d+))|(https:\/\/vt\.tiktok\.com\/[a-zA-Z0-9_-]+\/)$/;

function isValidTikTokLink(link) {
  return tikTokLinkRegex.test(link);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(publicDirectory));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDirectory, "index.html"));
});

app.get("/dashboard", (req, res) => {
  if (req.session.authenticated) {
    res.sendFile(path.join(publicDirectory, "dashboard.html"));
  } else {
    res.redirect("/");
  }
});

app.get("/dashboard/data", (req, res) => {
  if (req.session.authenticated && req.session.isAdmin) {
    const userData = users.users.map(user => ({
      username: user.username,
      apiKey: user.apiKey,
      ip: user.ip || "Not available"
    }));
    res.json({ users: userData, videos: videos.videos });
  } else {
    res.status(401).json({ error: "Unauthorized: Admin authentication required." });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(publicDirectory, "login.html"));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

  if (username === 'admin' && password === 'hutchin') {
    req.session.authenticated = true;
    req.session.isAdmin = true;

    const existingUser = users.users.find(u => u.username === username);
    if (existingUser) {
      existingUser.ip = clientIp;
      fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), "utf-8");
    }

    res.redirect("/dashboard");
  } else {
    res.status(401).json({ error: "Authentication failed" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

app.get("/credits", (req, res) => {
  res.sendFile(path.join(publicDirectory, "credits.html"));
});

app.post("/video", async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "Please provide a valid username." });
    }

    const apiKey = uuidv4();

    if (videos.videos.length > 0) {
      const randomIndex = Math.floor(Math.random() * videos.videos.length);
      const videoLink = videos.videos[randomIndex];
      saveUser(username, apiKey, req.ip);
      req.session.requestCount = (req.session.requestCount || 0) + 1;
      res.json({ apiKey, videoLink });
    } else {
      return res.status(500).json({ error: "No video links available." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

function saveVideoLink(videoLink) {
  if (!videos) {
    videos = { videos: [] };
  }

  videos.videos.push(videoLink);
  fs.writeFileSync(videosFilePath, JSON.stringify(videos, null, 2), "utf-8");
}

app.get("/upload", (req, res) => {
  res.sendFile(path.join(publicDirectory, "upload.html"));
});

app.post("/upload", (req, res) => {
  try {
    const { videoLink } = req.body;

    if (!videoLink || !isValidTikTokLink(videoLink)) {
      return res.status(400).json({ error: "Please provide a valid TikTok video link." });
    }

    saveVideoLink(videoLink);
    res.status(201).json({ message: "Video link uploaded successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/video/:apiKey", async (req, res) => {
  try {
    const apiKeyParam = req.params.apiKey;
    const user = users.users.find(u => u.apiKey === apiKeyParam);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized: Invalid API key." });
    }

    if (videos.videos.length > 0) {
      const randomIndex = Math.floor(Math.random() * videos.videos.length);
      const tikTokUrl = videos.videos[randomIndex];
      console.log("TikTok URL:", tikTokUrl);

      const downloadLink = await getDownloadLink(tikTokUrl);
      console.log("Download Link:", downloadLink);

      if (downloadLink) {
        const videoStream = await axios({
          method: 'get',
          url: downloadLink,
          responseType: 'stream'
        }).then(res => res.data);

        // Set headers for streaming video
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'inline');

        // Pipe the video stream directly to the response
        videoStream.pipe(res);
      } else {
        return res.status(500).json({ error: "Error retrieving TikTok video link." });
      }
    } else {
      return res.status(500).json({ error: "No video links available." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});
