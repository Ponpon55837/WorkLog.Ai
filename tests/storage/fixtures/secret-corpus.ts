/**
 * A fictional corpus of credential-bearing strings, one entry per realistic way a secret shows up in agent text.
 * Every `secrets` value must disappear from the redacted text. Prefixes that secret scanners match are joined at
 * runtime so this file itself holds no complete token-shaped literal.
 */
export interface CorpusSample {
  category: string;
  text: string;
  secrets: string[];
}

const ALPHABET = "ZqKdLmXwRtPvNbHcJyFgSaWeUoIzMxQkDlThVn27594836";

/** Deterministic mixed-case alphanumeric filler: not hex-only, not a word, never a placeholder. */
function fake(seed: number, length: number): string {
  let state = seed * 7919 + 13;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    output += ALPHABET[(state >>> 11) % ALPHABET.length];
  }
  return output;
}

function hex(seed: number, length: number): string {
  let state = seed * 104729 + 7;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    output += "0123456789abcdef"[(state >>> 11) % 16];
  }
  return output;
}

/** A 40-character AWS-style secret access key. */
const AWS_SECRET = `${fake(90, 17)}/${fake(91, 11)}+${fake(92, 10)}`;
const AWS_KEY_ID = `AKIA${fake(93, 16)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "A")}`;

function sample(category: string, text: string, ...secrets: string[]): CorpusSample {
  return { category, text, secrets };
}

const PEM_BODY = `${fake(1, 64)}\n${fake(2, 64)}\n${fake(3, 40)}`;
const PGP_BODY = `lQOYBGZ${fake(4, 60)}\n${fake(5, 64)}\n=${fake(6, 4)}`;
const PUTTY_PRIVATE = `${fake(7, 60)}\n${fake(8, 60)}`;

export const SECRET_CORPUS: readonly CorpusSample[] = [
  // Baseline: shapes the detectors already handled before this extension.
  sample("baseline", `token ghp_${fake(10, 36)} used`, fake(10, 36)),
  sample("baseline", `github_pat_${fake(11, 60)}`, fake(11, 60)),
  sample("baseline", `OPENAI sk-${fake(12, 30)}`, fake(12, 30)),
  sample("baseline", `sk-ant-api03-${fake(13, 30)}`, fake(13, 30)),
  sample("baseline", `xoxb-123456789012-${fake(14, 24)}`, fake(14, 24)),
  sample("baseline", `AIza${fake(15, 35)}`, fake(15, 35)),
  sample("baseline", `id ${AWS_KEY_ID} here`, AWS_KEY_ID),
  sample("baseline", `aws_secret_access_key=${AWS_SECRET}`, AWS_SECRET),
  sample("baseline", `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`, PEM_BODY),
  sample("baseline", `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`, PEM_BODY),
  sample("baseline", `eyJ${fake(16, 18)}.${fake(17, 20)}.${fake(18, 20)}`, fake(17, 20)),
  sample("baseline", `postgres://worker:${fake(19, 20)}@db.local/work`, fake(19, 20)),
  sample("baseline", `API_KEY=${fake(20, 20)}`, fake(20, 20)),
  sample("baseline", `Password: ${fake(21, 20)}`, fake(21, 20)),
  sample("baseline", `apiKey=${fake(22, 20)}`, fake(22, 20)),
  sample("baseline", `secret: "${fake(23, 16)}"`, fake(23, 16)),
  sample("baseline", `x-api-key: ${fake(24, 24)}`, fake(24, 24)),
  sample("baseline", `run --token=${fake(25, 24)}`, fake(25, 24)),
  sample("baseline", `{secret: '${fake(26, 16)}'}`, fake(26, 16)),
  sample("baseline", `mongodb+srv://svc:${fake(27, 20)}@cluster0.example.net/app`, fake(27, 20)),
  sample("baseline", `https://example.test/?key=sk-${fake(28, 24)}&x=1`, fake(28, 24)),
  sample(
    "baseline",
    `ASIA${fake(29, 16)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "B")}`,
    "ASIA",
  ),

  // 1. Environment names with an underscore prefix.
  sample("env-prefix", `DB_PASSWORD=${fake(30, 16)}`, fake(30, 16)),
  sample("env-prefix", `GITHUB_TOKEN=${fake(31, 28)}`, fake(31, 28)),
  sample("env-prefix", `SECRET_KEY=${fake(32, 32)}`, fake(32, 32)),
  sample("env-prefix", `AWS_SESSION_TOKEN=${fake(33, 40)}`, fake(33, 40)),
  sample("env-prefix", `client_secret=${fake(34, 24)}`, fake(34, 24)),
  sample("env-prefix", `passwd=${fake(35, 14)}`, fake(35, 14)),
  sample("env-prefix", `pwd=${fake(36, 14)}`, fake(36, 14)),
  sample("env-prefix", `credentials=${fake(37, 20)}`, fake(37, 20)),
  sample("env-prefix", `passphrase=${fake(38, 20)}`, fake(38, 20)),
  sample("env-prefix", `export REDIS_PASSWORD="${fake(39, 18)}"`, fake(39, 18)),
  sample("env-prefix", `MY_SERVICE_API_KEY: ${fake(40, 22)}`, fake(40, 22)),
  sample("env-prefix", `env: { STRIPE_SECRET: '${fake(41, 20)}' }`, fake(41, 20)),

  // 2. camelCase names.
  sample("camel-case", `accessToken: "${fake(42, 24)}"`, fake(42, 24)),
  sample("camel-case", `clientSecret=${fake(43, 24)}`, fake(43, 24)),
  sample("camel-case", `authToken: ${fake(44, 24)}`, fake(44, 24)),
  sample("camel-case", `const config = { apiKey: '${fake(45, 24)}', region: 'x' }`, fake(45, 24)),
  sample("camel-case", `refreshToken = "${fake(46, 30)}";`, fake(46, 30)),
  sample("camel-case", `dbPassword: ${fake(47, 16)}`, fake(47, 16)),

  // 3. JSON key/value pairs.
  sample("json", `{"password": "${fake(48, 16)}"}`, fake(48, 16)),
  sample("json", `{"api_key": "${fake(49, 24)}", "user": "ann"}`, fake(49, 24)),
  sample("json", `{"token":"${fake(50, 30)}"}`, fake(50, 30)),
  sample("json", `{"aws_secret_access_key": "${AWS_SECRET}"}`, AWS_SECRET),
  sample("json", `{"outer": {"client_secret": "${fake(51, 20)}", "ok": true}}`, fake(51, 20)),
  sample("json", `{"password": "has \\"quotes\\" and ${fake(52, 10)}"}`, fake(52, 10)),
  sample("json", `payload={\\"password\\":\\"${fake(53, 18)}\\"}`, fake(53, 18)),
  sample("json", `{"accessToken": "${fake(54, 24)}"}`, fake(54, 24)),

  // 4. Passwords with special characters or spaces.
  sample("special", `password="p@ss w0rd! ${fake(55, 6)}"`, fake(55, 6)),
  sample("special", `PASSWORD=P@$$w0rd!#${fake(56, 6)}`, fake(56, 6)),
  sample("special", `pwd=Ab;cd&ef*gh!${fake(57, 4)}`, fake(57, 4)),
  sample("special", `password: 'two words ${fake(58, 8)}'`, fake(58, 8)),
  sample("special", `DB_PASSWORD="a b,c;d ${fake(59, 8)} e"`, fake(59, 8)),
  sample("special", `passwd=${fake(60, 5)}!%^&*(${fake(61, 5)}`, fake(60, 5), fake(61, 5)),

  // 5. HTTP headers.
  sample("header", `Authorization: Bearer ${fake(62, 32)}`, fake(62, 32)),
  sample("header", `authorization: basic ${Buffer.from(`ann:${fake(63, 12)}`).toString("base64")}`, fake(63, 12)),
  sample("header", `AUTHORIZATION: Token ${fake(64, 30)}`, fake(64, 30)),
  sample("header", `Cookie: sessionid=${fake(65, 24)}; csrftoken=${fake(66, 24)}`, fake(65, 24), fake(66, 24)),
  sample("header", `Set-Cookie: sid=${fake(67, 24)}; Path=/; HttpOnly`, fake(67, 24)),
  sample("header", `curl -H "Authorization: Bearer ${fake(68, 32)}" https://api.example.test/v1`, fake(68, 32)),
  sample("header", `curl -H 'Cookie: sid=${fake(69, 24)}' https://api.example.test`, fake(69, 24)),
  sample("header", `{"headers": {"Authorization": "Bearer ${fake(70, 32)}"}}`, fake(70, 32)),

  // 6. Third-party prefixes.
  sample("prefix", `stripe ${"sk_"}${"live_"}${fake(71, 24)}`, fake(71, 24)),
  sample("prefix", `restricted ${"rk_"}${"live_"}${fake(72, 24)}`, fake(72, 24)),
  sample("prefix", `${"glpat"}-${fake(73, 20)}`, fake(73, 20)),
  sample("prefix", `${"npm"}_${fake(74, 36)}`, fake(74, 36)),
  sample("prefix", `${"SG"}.${fake(75, 22)}.${fake(76, 43)}`, fake(75, 22), fake(76, 43)),
  sample("prefix", `${"ya29"}.${fake(77, 60)}`, fake(77, 60)),
  sample("prefix", `${"GOCSPX"}-${fake(78, 28)}`, fake(78, 28)),
  sample("prefix", `${"xapp"}-1-A0123456789-${fake(79, 30)}`, fake(79, 30)),
  sample("prefix", `https://hooks.slack.com/services/T0FICTION1/B0FICTION2/${fake(80, 24)}`, fake(80, 24)),
  sample("prefix", `${"hf"}_${fake(81, 34)}`, fake(81, 34)),
  sample("prefix", `twilio ${"SK"}${hex(82, 32)}`, hex(82, 32)),

  // 7. Connection strings and query parameters.
  sample(
    "url",
    `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${fake(83, 40)}==;EndpointSuffix=core.example.test`,
    fake(83, 40),
  ),
  sample("url", `postgres://app:p@ss/word${fake(84, 6)}@db.example.test:5432/main`, fake(84, 6)),
  sample("url", `postgres://app:${fake(85, 8)}@${fake(86, 8)}@db.example.test/main`, fake(85, 8), fake(86, 8)),
  sample("url", `https://api.example.test/v1/items?access_token=${fake(87, 28)}&page=2`, fake(87, 28)),
  sample("url", `GET /search?api_key=${fake(88, 28)}&q=x`, fake(88, 28)),
  sample("url", `https://maps.example.test/json?q=a&key=${fake(89, 28)}`, fake(89, 28)),
  sample(
    "url",
    `https://bucket.example.test/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${hex(94, 64)}`,
    hex(94, 64),
  ),
  sample("url", `https://u:${fake(95, 10)}%2F${fake(96, 6)}@host.example.test/path`, fake(95, 10)),

  // 8. Private key variants.
  sample("pem", `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${PGP_BODY}\n-----END PGP PRIVATE KEY BLOCK-----`, PGP_BODY),
  sample("pem", `-----begin private key-----\n${PEM_BODY}\n-----end private key-----`, PEM_BODY),
  sample("pem", `-----begin rsa private key-----\n${PEM_BODY}\n-----end rsa private key-----`, PEM_BODY),
  sample(
    "pem",
    `PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\nComment: demo\nPublic-Lines: 2\n${fake(97, 40)}\nPrivate-Lines: 2\n${PUTTY_PRIVATE}\nPrivate-MAC: ${hex(98, 40)}\nafter`,
    PUTTY_PRIVATE,
  ),
  sample(
    "pem",
    `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: demo\nPublic-Lines: 1\n${fake(99, 40)}\nPrivate-Lines: 1\n${fake(100, 44)}\nPrivate-MAC: ${hex(101, 64)}`,
    fake(100, 44),
  ),
  sample(
    "pem",
    `json: "-----BEGIN PGP PRIVATE KEY BLOCK-----\\n${PGP_BODY.replace(/\n/g, "\\n")}\\n-----END PGP PRIVATE KEY BLOCK-----"`,
    fake(5, 64),
  ),

  // 9. AWS variants.
  sample("aws", `${AWS_KEY_ID} ${AWS_SECRET}`, AWS_SECRET),
  sample("aws", `${AWS_KEY_ID},${AWS_SECRET}`, AWS_SECRET),
  sample("aws", `[default]\naccess: ${AWS_KEY_ID}\n${AWS_SECRET}\nregion=eu`, AWS_SECRET),
  sample("aws", `secretAccessKey: "${AWS_SECRET}"`, AWS_SECRET),
  sample("aws", `AWS_SECRET_KEY=${AWS_SECRET}`, AWS_SECRET),
  sample("aws", `MY_AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, AWS_SECRET),
  sample("aws", `KEY_${AWS_KEY_ID}_x`, AWS_KEY_ID),
  sample("aws", `id_${AWS_KEY_ID}`, AWS_KEY_ID),

  // Further realistic shapes: logs, shell sessions, config files and prose around a secret.
  sample("env-prefix", `export GITLAB_TOKEN=${fake(110, 26)} && make deploy`, fake(110, 26)),
  sample("env-prefix", `docker run -e POSTGRES_PASSWORD=${fake(111, 18)} postgres`, fake(111, 18)),
  sample("env-prefix", `.env:\nSMTP_PASSWORD=${fake(112, 18)}\nSMTP_USER=ann`, fake(112, 18)),
  sample("camel-case", `headers.accessToken = "${fake(113, 28)}"`, fake(113, 28)),
  sample("camel-case", `{ clientSecret: "${fake(114, 28)}" }`, fake(114, 28)),
  sample("json", `{"db": {"password": "${fake(115, 18)}", "host": "localhost"}}`, fake(115, 18)),
  sample("json", `[{"name": "a", "secret": "${fake(116, 18)}"}]`, fake(116, 18)),
  sample("json", `{"credentials": "${fake(117, 24)}"}`, fake(117, 24)),
  sample("special", `password="${fake(118, 6)} ${fake(119, 6)}"`, fake(118, 6), fake(119, 6)),
  sample("special", `PASSWORD='${fake(120, 6)}"${fake(121, 6)}'`, fake(120, 6), fake(121, 6)),
  sample("header", `X-Auth-Token: ${fake(122, 30)}`, fake(122, 30)),
  sample("header", `> Authorization: Basic ${Buffer.from(`bob:${fake(123, 14)}`).toString("base64")}`, fake(123, 14)),
  sample("url", `https://example.test/cb?client_secret=${fake(124, 24)}&code=1`, fake(124, 24)),
  sample("url", `redis://:${fake(125, 12)}@cache.example.test:6379/0`, fake(125, 12)),
  sample("url", `amqp://guest:${fake(126, 8)}/${fake(127, 8)}@mq.example.test/vhost`, fake(126, 8), fake(127, 8)),
  sample("aws", `aws_access_key_id=${AWS_KEY_ID}\naws_secret_access_key=${AWS_SECRET}`, AWS_SECRET, AWS_KEY_ID),
  sample("aws", `export AWS_SECRET_ACCESS_KEY="${AWS_SECRET}"`, AWS_SECRET),
  sample("prefix", `STRIPE_KEY=${"sk_"}${"test_"}${fake(128, 24)}`, fake(128, 24)),
];

/** Strings that mention credentials without containing one; every one must come out unchanged. */
export const BENIGN_TEXTS: readonly string[] = [
  "password_reset",
  "password_reset=true",
  "tokenizer",
  "tokenizer: sentencepiece-model",
  "secretary",
  "secretary: Ms Chen will join",
  "token count",
  "token count: 4096",
  "max_tokens: 4096",
  "input_token: 12345678",
  "the password field is required",
  "the password field is required: please retry",
  "Enter your password to continue",
  `commit ${hex(200, 40)}`,
  `merged ${hex(201, 40)} into main`,
  hex(202, 40),
  `git log -1 ${hex(203, 40)} --stat`,
  "A plain English sentence about tokens, secrets and passwords without any assignment.",
  "這是一段普通的中文說明，提到密碼欄位與權杖數量，但沒有任何機密。",
  "密碼：請在設定頁輸入你的密碼，權杖數量：很多",
  'credentials: "include"',
  "credentials: 'same-origin'",
  "PWD=/home/user/project",
  "OLDPWD=/home/user/project",
  "Authorization: Bearer $TOKEN",
  "Authorization: Bearer <your-token>",
  "curl -H 'Authorization: Bearer ${API_TOKEN}' https://api.example.test",
  "password: <your-password>",
  "api_key=${API_KEY}",
  "const token = getToken(session)",
  "password: string;",
  "cookie: chocolate chip",
  "Set-Cookie: sid",
  "http://localhost:3000/user@example.com",
  "https://example.test/?key=short&page=1",
  "https://example.test/?token=abc",
  "password=********",
  "DB_PASSWORD=changeme",
  "aws_secret_access_key=your-secret",
  "AKIA is the prefix of an AWS access key id",
  "KEY_AKIAEXAMPLE_x",
  "-----BEGIN PGP PUBLIC KEY BLOCK-----\nabcdef\n-----END PGP PUBLIC KEY BLOCK-----",
  "hf_ is the prefix Hugging Face uses",
  "npm_config_cache=/tmp/npm-cache",
  "SG.short.short",
  // A boolean or small-number setting named like a credential.
  "axios.create({ withCredentials=false,timeout:5000 })",
  "set xhr.withCredentials=false; then retry the request",
  "const options = {includeCredentials:true,retries:3}",
  "db_credentials=null,mode:readonly",
  "withCredentials: undefined",
  // A key that is followed by the next markup attribute, not by a value.
  `v-model="form.options.password" :aria-label="t('settings.fields.password')"`,
  `<input name='password' :placeholder="t('login.password.hint')" />`,
  '<el-input v-model=`user.token` :maxlength="40" />',
  // Placeholder-shaped values, including this module's own redaction markers.
  `{"token": "[[PLACEHOLDER_a3f9c1]]"}`,
  `{"password": "{{ vault.dbPassword }}", "apiKey": "<insert-key-here>"}`,
  `{"secret": "[REDACTED:environment_secret]", "token": "[REDACTED]"}`,
  "api_key=[REDACTED:openai_token]",
  `{"token": "********************"}`,
  // A bare JSON "token" that is a text fragment from a tokenizer, not a credential.
  `{"token": "internationalization", "id": 4412}`,
  `{"token": "hello brave new world", "logprob": -2.3}`,
  `{"token": "ThisIsAFragment"}`,
  // Type annotations document a field; they are not values.
  "`account: string`, `password: string`, `fileName: string`",
  "interface Login { password?: string; token: string | null; secret: Buffer }",
  "`token: string|undefined`, `secret: Uint8Array`, `apiKey: unknown`",
  'def connect(password: str = "", token: str | None = None): ...',
  "type Settings = { password: undefined; passphrase: string[]; secret: number|string }",
  "type Credentials struct { Password string; Token string }",
  "欄位有 `account: string`、`password: string`、`fileName: string`。",
  "欄位有 `account: string`，`password: number`，`fileName: string`",
  "欄位：`account: string`；`token: boolean`；`fileName: string`",
  "`account: string`/`password: string`/`token: string`",
  "password: string、fileName: string",
  "欄位 password: boolean、token: number、secret: string。",
];
