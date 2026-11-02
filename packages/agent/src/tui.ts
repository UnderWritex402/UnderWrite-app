import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

export interface TuiRunOptions {
  requestPath: string;
  paymentMode: "order" | "skip";
  orderId: string | null;
  submit: boolean;
}

export interface ConfigurationItem {
  name: string;
  configured: boolean;
}

export interface ConfigurationGroup {
  title: string;
  items: ConfigurationItem[];
}

interface MenuItem<T extends string> {
  value: T;
  label: string;
  description: string;
}

export type TuiCommand =
  | "verify"
  | "status"
  | "help"
  | "clear"
  | "quit"
  | "empty"
  | "unknown";

const paymentMenu: MenuItem<"order" | "skip" | "back">[] = [
  {
    value: "order",
    label: "Settled merchant order",
    description: "Require an x402 merchant order to be settled before research.",
  },
  {
    value: "skip",
    label: "Controlled testnet bypass",
    description: "Skip payment explicitly for an operator-controlled testnet run.",
  },
  { value: "back", label: "Back", description: "Return to the Xwrite prompt." },
];

const submissionMenu: MenuItem<"no" | "yes" | "back">[] = [
  {
    value: "no",
    label: "Verify and sign only",
    description: "Store evidence locally without sending a Stellar transaction.",
  },
  {
    value: "yes",
    label: "Submit on Stellar testnet",
    description: "Send a successful attestation to the configured Invoice contract.",
  },
  { value: "back", label: "Back", description: "Return to the Xwrite prompt." },
];

const ansi = {
  clear: "\u001b[2J\u001b[H",
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
};

const wordmark = [
  "██╗  ██╗██╗    ██╗██████╗ ██╗████████╗███████╗",
  "╚██╗██╔╝██║    ██║██╔══██╗██║╚══██╔══╝██╔════╝",
  " ╚███╔╝ ██║ █╗ ██║██████╔╝██║   ██║   █████╗  ",
  " ██╔██╗ ██║███╗██║██╔══██╗██║   ██║   ██╔══╝  ",
  "██╔╝ ██╗╚███╔███╔╝██║  ██║██║   ██║   ███████╗",
  "╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝   ╚═╝   ╚══════╝",
];

function style(code: string, text: string): string {
  return process.stdout.isTTY ? `${code}${text}${ansi.reset}` : text;
}

function header(subtitle: string): string {
  return [
    style(ansi.cyan + ansi.bold, "XWRITE"),
    style(ansi.dim, "UnderWrite operator agent · Stellar testnet · v0.1.0"),
    "",
    style(ansi.bold, subtitle),
    "",
  ].join("\n");
}

export function parseTuiCommand(input: string): TuiCommand {
  const command = input.trim().toLowerCase().split(/\s+/, 1)[0];
  if (command === "") return "empty";
  if (command === "/verify" || command === "verify") return "verify";
  if (command === "/status" || command === "status") return "status";
  if (command === "/help" || command === "/?" || command === "help") {
    return "help";
  }
  if (command === "/clear" || command === "clear") return "clear";
  if (
    command === "/quit" ||
    command === "/exit" ||
    command === "quit" ||
    command === "exit"
  ) {
    return "quit";
  }
  return "unknown";
}

export function renderWelcome(
  projectName = basename(process.env.INIT_CWD ?? process.cwd()),
): string {
  const colors = [
    ansi.cyan,
    ansi.cyan,
    ansi.blue,
    ansi.blue,
    ansi.magenta,
    ansi.magenta,
  ];
  const logo = wordmark
    .map((line, index) => style(colors[index]! + ansi.bold, line))
    .join("\n");
  const tips = [
    style(ansi.bold, "Xwrite — UnderWrite verification agent"),
    "",
    style(ansi.dim, "Tips for getting started:"),
    `1. Type ${style(ansi.cyan, "/verify")} to inspect and verify an invoice.`,
    `2. Type ${style(ansi.cyan, "/status")} to check provider and signer readiness.`,
    `3. Type ${style(ansi.cyan, "/help")} to see commands and safety boundaries.`,
    "",
    style(
      ansi.dim,
      `${projectName}  ·  stellar-testnet  ·  operator mode  ·  v0.1.0`,
    ),
  ].join("\n");
  return `${ansi.clear}${logo}\n\n${tips}\n\n`;
}

export function nextMenuIndex(
  current: number,
  direction: "up" | "down",
  itemCount: number,
): number {
  if (itemCount < 1) return 0;
  return direction === "up"
    ? (current - 1 + itemCount) % itemCount
    : (current + 1) % itemCount;
}

export function buildCliArgs(options: TuiRunOptions): string[] {
  const args = ["--request", options.requestPath];
  if (options.paymentMode === "order") {
    if (options.orderId === null || options.orderId.trim() === "") {
      throw new Error("a merchant order id is required for the paid path");
    }
    args.push("--order-id", options.orderId.trim());
  } else {
    args.push("--skip-payment");
  }
  if (options.submit) args.push("--submit");
  return args;
}

export function configurationGroups(
  env: NodeJS.ProcessEnv = process.env,
): ConfigurationGroup[] {
  const present = (name: string): ConfigurationItem => ({
    name,
    configured: typeof env[name] === "string" && env[name]!.trim() !== "",
  });

  return [
    {
      title: "Verification identity",
      items: [present("AGENT_EVM_PRIVATE_KEY"), present("AGENT_ID")],
    },
    {
      title: "Evidence providers",
      items: [
        present("TRUSTROVE_INDEXER_URL"),
        present("CAC_LOOKUP_PROVIDER"),
        present("CAC_LOOKUP_BASE_URL"),
        present("CAC_LOOKUP_API_KEY"),
        present("WEB_SEARCH_PROVIDER"),
        present("WEB_SEARCH_API_KEY"),
      ],
    },
    {
      title: "Paid path",
      items: [
        present("MERCHANT_PORTAL_BASE_URL"),
        present("MERCHANT_PORTAL_EMAIL"),
        present("MERCHANT_PORTAL_PASSWORD"),
      ],
    },
    {
      title: "Stellar submission",
      items: [
        present("STELLAR_RPC_URL"),
        present("STELLAR_NETWORK_PASSPHRASE"),
        present("STELLAR_SUBMITTER_SECRET"),
        present("TRUSTROVE_INVOICE_CONTRACT"),
      ],
    },
  ];
}

function renderMenu<T extends string>(
  title: string,
  items: MenuItem<T>[],
  selected: number,
): string {
  const rows = items.flatMap((item, index) => {
    const active = index === selected;
    const marker = active ? style(ansi.cyan, "❯") : " ";
    const label = active ? style(ansi.bold, item.label) : item.label;
    const description = active ? style(ansi.dim, item.description) : "";
    return [`${marker} ${label}`, `    ${description}`];
  });
  return `${ansi.clear}${header(title)}${rows.join("\n")}\n\n${style(ansi.dim, "↑/↓ or j/k move · Enter selects · q cancels or exits")}`;
}

async function selectMenu<T extends string>(
  title: string,
  items: MenuItem<T>[],
): Promise<T | "__quit"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the TUI requires an interactive terminal");
  }

  let selected = 0;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(renderMenu(title, items, selected));

  return await new Promise((resolveSelection) => {
    const finish = (selection: T | "__quit") => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ansi.reset}\n`);
      resolveSelection(selection);
    };

    const onKeypress = (
      input: string,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if ((key.ctrl && key.name === "c") || input === "q") {
        finish("__quit");
        return;
      }
      if (key.name === "up" || input === "k") {
        selected = nextMenuIndex(selected, "up", items.length);
      } else if (key.name === "down" || input === "j") {
        selected = nextMenuIndex(selected, "down", items.length);
      } else if (key.name === "return") {
        finish(items[selected]!.value);
        return;
      } else {
        return;
      }
      process.stdout.write(renderMenu(title, items, selected));
    };

    process.stdin.on("keypress", onKeypress);
  });
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

async function pause(): Promise<void> {
  await ask(`\n${style(ansi.dim, "Press Enter to return to Xwrite.")}`);
}

async function requestPathPrompt(): Promise<string | null> {
  process.stdout.write(`${ansi.clear}${header("New verification")}`);
  const entered = await ask("Request JSON path (blank to cancel): ");
  if (entered === "") return null;
  const absolute = resolve(entered);
  await access(absolute);
  return absolute;
}

async function runWizard(): Promise<void> {
  let requestPath: string | null;
  try {
    requestPath = await requestPathPrompt();
  } catch (error) {
    process.stdout.write(
      `\n${style(ansi.red, `Cannot read request: ${error instanceof Error ? error.message : String(error)}`)}\n`,
    );
    await pause();
    return;
  }
  if (requestPath === null) return;

  const paymentMode = await selectMenu("Choose payment gate", paymentMenu);
  if (paymentMode === "__quit" || paymentMode === "back") return;

  let orderId: string | null = null;
  if (paymentMode === "order") {
    process.stdout.write(`${ansi.clear}${header("Merchant order")}`);
    orderId = await ask("Settled merchant order id (blank to cancel): ");
    if (orderId === "") return;
  }

  const submission = await selectMenu("Choose submission mode", submissionMenu);
  if (submission === "__quit" || submission === "back") return;

  const options: TuiRunOptions = {
    requestPath,
    paymentMode,
    orderId,
    submit: submission === "yes",
  };

  process.stdout.write(`${ansi.clear}${header("Confirm verification")}`);
  process.stdout.write(`Request   ${requestPath}\n`);
  process.stdout.write(
    `Payment   ${paymentMode === "order" ? `merchant order ${orderId}` : "CONTROLLED TESTNET BYPASS"}\n`,
  );
  process.stdout.write(
    `Submit    ${options.submit ? style(ansi.yellow, "YES — Stellar transaction enabled") : "No — sign and store only"}\n`,
  );
  const confirmationWord = options.submit ? "SUBMIT" : "RUN";
  const confirmation = await ask(
    `\nType ${confirmationWord} to continue: `,
  );
  if (confirmation !== confirmationWord) return;

  process.stdout.write(`${ansi.clear}${header("Verification running")}`);
  try {
    const code = await runCli(buildCliArgs(options));
    const color = code === 0 ? ansi.green : code === 2 ? ansi.yellow : ansi.red;
    process.stdout.write(`\n${style(color, `Completed with exit code ${code}.`)}\n`);
  } catch (error) {
    process.stdout.write(
      `\n${style(ansi.red, `Verification failed: ${error instanceof Error ? error.message : String(error)}`)}\n`,
    );
  }
  await pause();
}

async function showConfiguration(): Promise<void> {
  const groups = configurationGroups();
  const lines = groups.flatMap((group) => [
    style(ansi.bold, group.title),
    ...group.items.map((item) => {
      const status = item.configured
        ? style(ansi.green, "● configured")
        : style(ansi.red, "○ missing");
      return `  ${status}  ${item.name}`;
    }),
    "",
  ]);
  process.stdout.write(
    `${ansi.clear}${header("Configuration status")}${lines.join("\n")}${style(ansi.dim, "Values are intentionally never displayed.")}\n`,
  );
  await pause();
}

async function showHelp(): Promise<void> {
  const text = [
    `${style(ansi.cyan, "/verify")}   Start the guided invoice verification workflow.`,
    `${style(ansi.cyan, "/status")}   Check configuration without displaying values.`,
    `${style(ansi.cyan, "/clear")}    Clear and redraw the Xwrite session.`,
    `${style(ansi.cyan, "/help")}     Show this command reference.`,
    `${style(ansi.cyan, "/quit")}     Exit Xwrite.`,
    "",
    "Inside selection dialogs, use ↑/↓ or j/k and Enter.",
    "Verify and sign only stores the evidence report without a Stellar write.",
    "Submit on Stellar testnet sends a successful attestation on-chain.",
    "The payment bypass is only for a controlled testnet operator run.",
    "",
    "Exit codes: 0 signed result · 2 insufficient evidence · 1 failure.",
    "The TUI never displays configured keys, seeds, passwords, or API tokens.",
  ].join("\n");
  process.stdout.write(`${ansi.clear}${header("Operator help")}${text}\n`);
  await pause();
}

export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the UnderWrite TUI requires an interactive terminal");
  }

  process.stdout.write(renderWelcome());
  while (true) {
    const input = await ask(`${style(ansi.cyan + ansi.bold, "❯")} `);
    const command = parseTuiCommand(input);
    if (command === "quit") return 0;
    if (command === "verify") await runWizard();
    if (command === "status") await showConfiguration();
    if (command === "help") await showHelp();
    if (command === "clear") process.stdout.write(renderWelcome());
    if (command === "unknown") {
      process.stdout.write(
        `${style(ansi.yellow, `Unknown command: ${input}`)}\n${style(ansi.dim, "Type /help to see available commands.")}\n\n`,
      );
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runTui()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stdin.isTTY && process.stdin.setRawMode(false);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`xwrite: ${message}\n`);
      process.exitCode = 1;
    });
}
