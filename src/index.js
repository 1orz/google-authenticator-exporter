const protobuf = require("protobufjs");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const readline = require("readline");
const sharp = require("sharp");
const jsQR = require("jsqr");
const base32 = require("./edbase32");

const PROTO_PATH = path.join(__dirname, "google_auth.proto");
const DIGITS_MAP = { SIX: 6, SEVEN: 7, EIGHT: 8, DIGIT_COUNT_UNSPECIFIED: 6 };

// === Core ===

function decodeProtobuf(payload) {
  const root = protobuf.loadSync(PROTO_PATH);
  const MigrationPayload = root.lookupType("googleauth.MigrationPayload");
  const message = MigrationPayload.decode(payload);
  return MigrationPayload.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
  });
}

function toBase32(base64String) {
  const raw = Buffer.from(base64String, "base64");
  return base32.encode(raw);
}

function decode(data) {
  const buffer = Buffer.from(decodeURIComponent(data), "base64");
  const payload = decodeProtobuf(buffer);

  const knownVersions = ["1", "2"];
  if (!knownVersions.includes(String(payload.version))) {
    console.error(
      `Unknown payload version ${payload.version} (known: ${knownVersions.join(", ")}). ` +
      "Please report at https://github.com/krissrex/google-authenticator-exporter/issues/23"
    );
  }

  return payload.otpParameters.map((account) => ({
    ...account,
    totpSecret: toBase32(account.secret),
  }));
}

function decodeExportUri(uri) {
  const queryParams = new URL(uri).search;
  const data = new URLSearchParams(queryParams).get("data");
  return decode(data);
}

function buildOtpauthUri(account) {
  const type = (account.type || "TOTP").toLowerCase();
  const name = account.name || "";
  const issuer = account.issuer || "";
  const secret = account.totpSecret;

  const label = issuer ? `${issuer}:${name}` : name;
  const params = new URLSearchParams();
  params.set("secret", secret.replace(/=+$/, ""));
  if (issuer) params.set("issuer", issuer);

  const algo = account.algorithm || "SHA1";
  if (algo !== "SHA1" && algo !== "ALGORITHM_UNSPECIFIED") {
    params.set("algorithm", algo);
  }

  const digits = DIGITS_MAP[account.digits] || 6;
  if (digits !== 6) params.set("digits", String(digits));

  if (type === "hotp" && account.counter) {
    params.set("counter", account.counter);
  }

  return `otpauth://${type}/${encodeURIComponent(label)}?${params.toString()}`;
}

function accountKey(account) {
  return `${account.type || ""}:${account.issuer || ""}:${account.name || ""}:${account.totpSecret || ""}`;
}

function deduplicateAccounts(accounts) {
  const seen = new Set();
  const unique = [];
  for (const account of accounts) {
    const key = accountKey(account);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(account);
    }
  }
  return unique;
}

async function decodeQRFromImage(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!code) throw new Error("No QR code found in image");
  return code.data;
}

function cleanFilePath(input) {
  return input
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\ /g, " ")
    .trim();
}

async function resolveInput(input) {
  input = input.trim();
  if (input.startsWith("otpauth-migration://")) {
    return input;
  }

  const filePath = cleanFilePath(input);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      "Input is not a valid URI or file path.\n" +
      "Expected: otpauth-migration://offline?data=... or path to QR code image"
    );
  }

  return await decodeQRFromImage(filePath);
}

// === CLI ===

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function printAccountInfo(account, index, total) {
  console.log(c.bold(`  Account ${index + 1}/${total}`));
  console.log(`  Name:      ${c.cyan(account.name || "(empty)")}`);
  console.log(`  Issuer:    ${c.cyan(account.issuer || "(empty)")}`);
  console.log(`  Algorithm: ${account.algorithm || "SHA1"}`);
  console.log(`  Digits:    ${DIGITS_MAP[account.digits] || 6}`);
  console.log(`  Type:      ${account.type || "TOTP"}`);
}

async function printQR(account) {
  const uri = buildOtpauthUri(account);
  const qr = await QRCode.toString(uri, { type: "terminal", small: true });
  console.log(qr);
}

async function displayAccountQR(account, index, total, rl) {
  printAccountInfo(account, index, total);
  console.log();
  await printQR(account);

  const newName = await ask(
    rl,
    `  New name ${c.dim(`(Enter to keep "${account.name || ""}")`)}: `
  );
  if (newName.trim()) {
    account.name = newName.trim();
    console.log();
    printAccountInfo(account, index, total);
    console.log();
    await printQR(account);
  }

  const newIssuer = await ask(
    rl,
    `  New issuer ${c.dim(`(Enter to keep "${account.issuer || ""}")`)}: `
  );
  if (newIssuer.trim()) {
    account.issuer = newIssuer.trim();
    console.log();
    printAccountInfo(account, index, total);
    console.log();
    await printQR(account);
  }
}

async function qrCodeMode(accounts, rl) {
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) console.log("\n" + "=".repeat(50) + "\n");
    await displayAccountQR(accounts[i], i, accounts.length, rl);
  }
}

async function jsonMode(accounts, rl) {
  const answer = await ask(rl, "Save to file? (y/N): ");
  if (answer.trim().toLowerCase().startsWith("y")) {
    const filename = await ask(rl, "Filename: ");
    if (filename.trim()) {
      if (fs.existsSync(filename.trim())) {
        console.error(c.red(`File "${filename.trim()}" already exists!`));
      } else {
        fs.writeFileSync(filename.trim(), JSON.stringify(accounts, undefined, 4));
        console.log(c.green(`Saved to "${filename.trim()}".`));
      }
    }
  } else {
    console.log(JSON.stringify(accounts, undefined, 2));
    console.log(c.yellow("\nUse 'totpSecret' as the secret key for other authenticator apps."));
  }
}

function toBitwardenJson(accounts) {
  const now = new Date().toISOString();
  return {
    encrypted: false,
    folders: [],
    items: accounts.map((account) => {
      const name = account.issuer || account.name || "Unknown";
      const username = account.name || "";
      return {
        id: crypto.randomUUID(),
        folderId: null,
        organizationId: null,
        collectionIds: null,
        name,
        notes: null,
        type: 1,
        login: {
          username,
          password: null,
          uris: [],
          totp: buildOtpauthUri(account),
          fido2Credentials: [],
        },
        favorite: false,
        reprompt: 0,
        passwordHistory: null,
        revisionDate: now,
        creationDate: now,
        deletedDate: null,
      };
    }),
  };
}

async function bitwardenMode(accounts, rl) {
  const filename = await ask(rl, `Filename ${c.dim("(default: bitwarden.json)")}: `);
  const target = filename.trim() || "bitwarden.json";
  if (fs.existsSync(target)) {
    console.error(c.red(`File "${target}" already exists!`));
    return;
  }
  const data = toBitwardenJson(accounts);
  fs.writeFileSync(target, JSON.stringify(data, undefined, 2));
  console.log(c.green(`Saved ${accounts.length} account(s) to "${target}".`));
  console.log(c.dim("Import in Bitwarden: Settings > Import > select format 'Bitwarden (json)'"));
}

function loadAccountsFromJson(filePath) {
  const resolved = cleanFilePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  const accounts = Array.isArray(data) ? data : [data];
  for (const account of accounts) {
    if (!account.totpSecret) {
      throw new Error(`Invalid JSON: missing 'totpSecret' field in account "${account.name || "(unknown)"}"`);
    }
  }
  return accounts;
}

async function fromJsonMode(jsonPath) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const raw = loadAccountsFromJson(jsonPath);
    const accounts = deduplicateAccounts(raw);
    const dupes = raw.length - accounts.length;
    console.log(c.bold("\nGoogle Authenticator Exporter\n"));
    let msg = `Loaded ${accounts.length} account(s) from JSON.`;
    if (dupes > 0) msg += c.yellow(` (${dupes} duplicate(s) removed)`);
    console.log(c.green(msg) + "\n");
    await qrCodeMode(accounts, rl);
  } catch (err) {
    console.error(c.red(`Error: ${err.message}`));
  } finally {
    rl.close();
  }
}

async function promptUserForUri() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(c.bold("\nGoogle Authenticator Exporter\n"));
  console.log("Paste the URI, or drag a QR code image into the terminal.");
  console.log(c.dim("URI format: otpauth-migration://offline?data=..."));
  console.log(c.dim("Image: drag .png/.jpg file here, or paste the file path\n"));
  console.log(c.red("Warning: the exported data contains your 2FA secrets."));
  console.log(c.red("Do not use untrusted QR decoders or transfer methods.\n"));

  try {
    const allAccounts = [];

    while (true) {
      const prompt = allAccounts.length === 0
        ? "URI or image path: "
        : `URI or image path ${c.dim("(Enter to finish)")}: `;
      const input = await ask(rl, prompt);
      if (!input.trim()) {
        if (allAccounts.length > 0) break;
        console.error("No input provided.");
        return;
      }

      const uri = await resolveInput(input);
      const accounts = decodeExportUri(uri);
      allAccounts.push(...accounts);
      const before = allAccounts.length;
      const deduplicated = deduplicateAccounts(allAccounts);
      const dupes = before - deduplicated.length;
      allAccounts.length = 0;
      allAccounts.push(...deduplicated);
      let msg = `  +${accounts.length} account(s), total: ${allAccounts.length}`;
      if (dupes > 0) msg += c.yellow(` (${dupes} duplicate(s) removed)`);
      console.log(c.green(msg) + "\n");
    }

    const accounts = allAccounts;
    console.log(c.green(`\n${accounts.length} account(s) ready.\n`));

    const mode = await ask(
      rl,
      `Output: ${c.bold("1")} JSON  ${c.bold("2")} QR Code  ${c.bold("3")} Bitwarden JSON\n> `
    );

    console.log();
    if (mode.trim() === "2") {
      await qrCodeMode(accounts, rl);
    } else if (mode.trim() === "3") {
      await bitwardenMode(accounts, rl);
    } else {
      await jsonMode(accounts, rl);
    }
  } catch (err) {
    console.error(c.red(`Error: ${err.message}`));
  } finally {
    rl.close();
  }
}

exports.decodeExportUri = decodeExportUri;
exports.buildOtpauthUri = buildOtpauthUri;
exports.decodeQRFromImage = decodeQRFromImage;
exports.loadAccountsFromJson = loadAccountsFromJson;
exports.deduplicateAccounts = deduplicateAccounts;
exports.toBitwardenJson = toBitwardenJson;

if (require.main === module) {
  const jsonFlagIndex = process.argv.indexOf("--from-json");
  if (jsonFlagIndex !== -1) {
    const jsonPath = process.argv[jsonFlagIndex + 1];
    if (!jsonPath) {
      console.error("Usage: node src/index.js --from-json <path-to-json>");
      process.exit(1);
    }
    fromJsonMode(jsonPath);
  } else {
    promptUserForUri();
  }
}
