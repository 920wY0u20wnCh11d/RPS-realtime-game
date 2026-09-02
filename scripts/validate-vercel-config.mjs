import fs from "node:fs";
import path from "node:path";

const configPath = path.resolve(process.cwd(), "vercel.json");

if (!fs.existsSync(configPath)) {
  console.log("[check:vercel-config] vercel.json not found, skipping.");
  process.exit(0);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  console.error("[check:vercel-config] Invalid JSON in vercel.json");
  console.error(error.message);
  process.exit(1);
}

const errors = [];

function walk(value, currentPath = "vercel.json") {
  if (!value || typeof value !== "object") return;

  if (Object.prototype.hasOwnProperty.call(value, "runtime")) {
    const runtimePath = `${currentPath}.runtime`;
    const runtime = value.runtime;

    if (typeof runtime !== "string" || !runtime.includes("@")) {
      errors.push(
        `${runtimePath} must be a versioned runtime package like @vercel/node@x.y.z, or be removed to use auto-detection.`
      );
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
    return;
  }

  Object.entries(value).forEach(([key, child]) => {
    walk(child, `${currentPath}.${key}`);
  });
}

walk(config);

if (errors.length) {
  console.error("[check:vercel-config] Configuration guard failed:");
  errors.forEach((err) => console.error(`- ${err}`));
  process.exit(1);
}

console.log("[check:vercel-config] OK");
