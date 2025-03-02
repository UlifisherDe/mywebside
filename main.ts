import { Application, Router } from "oak";
import { MongoClient } from "mongo";
import { create, verify } from "djwt";
import { renderFile } from "eta";

// 环境配置
const env = Deno.env.toObject();
const PORT = env.PORT || 8000;
const MONGO_URI = env.MONGO_URI || "mongodb://localhost:27017";
const JWT_SECRET = env.JWT_SECRET || "supersecret";

// 数据库连接
const client = new MongoClient();
await client.connect(MONGO_URI);
console.log("Connected to MongoDB");

interface User {
  _id: { $oid: string };
  username: string;
  password: string;
}

const db = client.database("deno_cms");
const users = db.collection<User>("users");

// Web应用初始化
const app = new Application();
const router = new Router();

// 中间件
app.use(async (ctx, next) => {
  ctx.response.headers.set("X-Powered-By", "Deno");
  await next();
});

// 路由配置
router
  .get("/", async (ctx) => {
    const userList = await users.find().toArray();
    ctx.response.body = await renderFile("views/index.eta", {
      users: userList,
      timestamp: new Date()
    });
  })
  .post("/api/register", async (ctx) => {
    const body = await ctx.request.body().value;
    const { username, password } = body;

    if (!username || !password) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Missing credentials" };
      return;
    }

    const existingUser = await users.findOne({ username });
    if (existingUser) {
      ctx.response.status = 409;
      ctx.response.body = { error: "User exists" };
      return;
    }

    const userId = await users.insertOne({
      username,
      password: await hashPassword(password)
    });

    const token = await createJwt(userId.toString(), username);
    ctx.response.body = { token };
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

// 启动应用
app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on port ${PORT}`);
await app.listen({ port: Number(PORT) });
