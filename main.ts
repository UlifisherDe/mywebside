// main.ts
import { Application, Router, helpers, Context } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { MongoClient } from "https://deno.land/x/mongo@v0.32.0/mod.ts";
import { create, verify } from "https://deno.land/x/djwt@v2.9.1/mod.ts";
import { renderFile } from "https://deno.land/x/eta@v2.2.0/mod.ts";
import { WebSocketClient, WebSocketServer } from "https://deno.land/x/websocket@v0.1.4/mod.ts";

// 环境配置
const env = Deno.env.toObject();
const PORT = env.PORT || 8000;
const MONGO_URI = env.MONGO_URI || "mongodb://localhost:27017";
const JWT_SECRET = env.JWT_SECRET || "supersecret";

// 数据库连接
const client = new MongoClient();
await client.connect(MONGO_URI);
interface User {
  _id: { $oid: string };
  username: string;
  password: string;
  createdAt: Date;
}

interface Post {
  title: string;
  content: string;
  author: string;
  createdAt: Date;
}

const db = client.database("deno_site");
const users = db.collection<User>("users");
const posts = db.collection<Post>("posts");

// WebSocket 服务器
const wss = new WebSocketServer(8080);
wss.on("connection", (ws: WebSocketClient) => {
  console.log("WebSocket connected");
  ws.on("message", (message: string) => {
    wss.clients.forEach(client => {
      client.send(`[${new Date().toLocaleTimeString()}] ${message}`);
    });
  });
});

// Oak 应用配置
const app = new Application();
const router = new Router();

// 中间件
app.use(async (ctx, next) => {
  console.log(`${ctx.request.method} ${ctx.request.url}`);
  await next();
});

// 用户认证中间件
const authMiddleware = async (ctx: Context, next: () => Promise<unknown>) => {
  const token = ctx.cookies.get("jwt");
  if (token) {
    try {
      const payload = await verify(token, JWT_SECRET, "HS256");
      ctx.state.user = payload;
    } catch (e) {
      ctx.cookies.delete("jwt");
    }
  }
  await next();
};

// 路由配置
router
  .get("/", async (ctx) => {
    const postList = await posts.find().toArray();
    ctx.response.body = await renderFile("views/index.eta", { 
      posts: postList,
      user: ctx.state.user 
    });
  })
  .post("/register", async (ctx) => {
    const { value } = ctx.request.body({ type: "form" });
    const formData = await value;
    const username = formData.get("username");
    const password = formData.get("password");

    const existingUser = await users.findOne({ username });
    if (existingUser) {
      ctx.response.redirect("/?error=User+exists");
      return;
    }

    const userId = await users.insertOne({
      username,
      password: await hashPassword(password),
      createdAt: new Date()
    });

    const token = await createJwt(userId.toString(), username);
    ctx.cookies.set("jwt", token);
    ctx.response.redirect("/");
  })
  .get("/chat", (ctx) => {
    ctx.response.body = await renderFile("views/chat.eta", {});
  })
  .post("/api/posts", authMiddleware, async (ctx) => {
    if (!ctx.state.user) {
      ctx.response.status = 401;
      return;
    }

    const { value } = ctx.request.body();
    const { title, content } = await value;
    await posts.insertOne({
      title,
      content,
      author: ctx.state.user.username,
      createdAt: new Date()
    });

    ctx.response.status = 201;
  })
  .get("/uploads/:filename", async (ctx) => {
    const { filename } = helpers.getQuery(ctx, { mergeParams: true });
    const file = await Deno.open(`./uploads/${filename}`);
    ctx.response.body = file;
  });

// 文件上传处理
app.use(async (ctx, next) => {
  if (ctx.request.method === "POST" && ctx.request.hasBody) {
    const body = ctx.request.body();
    if (body.type === "form-data") {
      const formData = await body.value.read();
      for (const file of formData.files || []) {
        const uploadPath = `./uploads/${file.filename}`;
        await Deno.writeFile(uploadPath, file.content);
      }
    }
  }
  await next();
});

// 工具函数
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createJwt(userId: string, username: string): Promise<string> {
  return await create(
    { alg: "HS256", typ: "JWT" },
    { sub: userId, username, exp: Date.now() + 3600_000 },
    JWT_SECRET
  );
}

// 静态文件服务
app.use(async (ctx, next) => {
  const filePath = `public${ctx.request.url.pathname}`;
  try {
    const file = await Deno.open(filePath, { read: true });
    ctx.response.body = file;
  } catch {
    await next();
  }
});

// 启动应用
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on http://localhost:${PORT}`);
await app.listen({ port: PORT });
