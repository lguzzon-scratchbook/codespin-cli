import { promises as fs } from "fs";
import { dirname, join, resolve } from "path";
import * as url from "url";
import { completion as openaiCompletion } from "../api/openai/completion.js";
import { exception } from "../exception.js";
import { getFileContent } from "../files/getFileContent.js";
import { extractFilesToDisk } from "../fs/extractFilesToDisk.js";
import { pathExists } from "../fs/pathExists.js";
import { writeToFile } from "../fs/writeToFile.js";
import { getDiff } from "../git/getDiff.js";
import { getFileFromCommit } from "../git/getFileFromCommit.js";
import { isCommitted } from "../git/isCommitted.js";
import { FileContent, evaluateTemplate } from "../prompts/evaluateTemplate.js";
import { readPromptSettings } from "../prompts/readPromptSettings.js";
import { removeFrontMatter } from "../prompts/removeFrontMatter.js";
import { readConfig } from "../settings/readConfig.js";
import { addLineNumbers } from "../text/addLineNumbers.js";
import { writeToConsole } from "../writeToConsole.js";

export type GenerateArgs = {
  promptFile: string | undefined;
  prompt: string | undefined;
  api: string | undefined;
  model: string | undefined;
  maxTokens: number | undefined;
  write: boolean | undefined;
  printPrompt: boolean | undefined;
  writePrompt: string | undefined;
  template: string | undefined;
  debug: boolean | undefined;
  exec: string | undefined;
  config: string | undefined;
  include: string[] | undefined;
  exclude: string[] | undefined;
  baseDir: string | undefined;
  multi: boolean | undefined;
};

export async function generate(args: GenerateArgs): Promise<void> {
  const configFile = resolve(args.config || "codespin.json");

  const config = (await pathExists(configFile))
    ? await readConfig(configFile)
    : undefined;

  const promptFileDir = args.promptFile ? dirname(args.promptFile) : undefined;

  const promptSettings = args.promptFile
    ? await readPromptSettings(args.promptFile)
    : {};

  // Get the source file, if it's a single file code-gen.
  // Single file prompts have a source.ext.prompt.md extension.
  const { sourceFileName } = await (async () => {
    if (
      args.promptFile !== undefined &&
      /\.[a-zA-Z0-9]+\.prompt\.md$/.test(args.promptFile)
    ) {
      if (!args.multi) {
        const sourceFileName = args.promptFile.replace(/\.prompt\.md$/, "");

        const sourceFileExists = await pathExists(sourceFileName);
        if (sourceFileExists) {
          return { sourceFileName };
        }
      }
    }
    return { sourceFileName: undefined };
  })();

  // Check if this file isn't excluded explicitly
  const sourceFile =
    sourceFileName && !(args.exclude || []).includes(sourceFileName)
      ? await getFileContent(sourceFileName)
      : undefined;

  // Remove dupes, and
  // then remove files which have been explicitly excluded
  const filesToInclude = removeDuplicates(
    (promptSettings?.include || []).concat(args.include || [])
  ).filter((x) => !(args.exclude || []).includes(x));

  const includedFilesOrNothing = await Promise.all(
    filesToInclude.map(getFileContent)
  );

  const includedFiles = (
    includedFilesOrNothing.filter(
      (x) => typeof x !== "undefined"
    ) as FileContent[]
  ).filter((x) => x.contents || x.previousContents);

  // Prompt file contents without frontMatter.
  const prompt = args.promptFile
    ? removeFrontMatter(await fs.readFile(args.promptFile, "utf-8"))
    : args.prompt ||
      exception(
        "The prompt file must be specified. See 'codespin generate help'."
      );

  const promptWithLineNumbers = addLineNumbers(prompt);

  const isPromptFileCommitted = args.promptFile
    ? await isCommitted(args.promptFile)
    : false;

  const { previousPrompt, previousPromptWithLineNumbers, promptDiff } =
    isPromptFileCommitted
      ? await (async () => {
          if (args.promptFile) {
            const fileFromCommit = await getFileFromCommit(args.promptFile);
            const previousPrompt =
              fileFromCommit !== undefined
                ? removeFrontMatter(fileFromCommit)
                : undefined;
            const previousPromptWithLineNumbers =
              previousPrompt !== undefined
                ? addLineNumbers(previousPrompt)
                : undefined;
            const promptDiff =
              previousPrompt !== undefined
                ? await getDiff(prompt, previousPrompt, args.promptFile)
                : undefined;
            return {
              previousPrompt,
              previousPromptWithLineNumbers,
              promptDiff,
            };
          } else {
            exception("invariant exception: missing prompt file");
          }
        })()
      : {
          previousPrompt: "",
          previousPromptWithLineNumbers: "",
          promptDiff: "",
        };

  // If the template is not provided, we'll use the default template.
  const templatePath =
    args.template && (await pathExists(args.template))
      ? resolve(args.template)
      : (await pathExists(
          resolve("codespin/templates", args.template || "default.mjs")
        ))
      ? resolve("codespin/templates", args.template || "default.mjs")
      : await (async () => {
          const __filename = url.fileURLToPath(import.meta.url);
          const builtInTemplatesDir = join(__filename, "../../templates");
          const builtInTemplatePath = resolve(
            builtInTemplatesDir,
            "default.js"
          );
          return (await pathExists(builtInTemplatePath))
            ? builtInTemplatePath
            : undefined;
        })();

  if (!templatePath) {
    throw new Error(
      `The template ${templatePath} was not found. Have you done 'codespin init'?`
    );
  }

  const evaluatedPrompt = await evaluateTemplate(templatePath, {
    prompt,
    promptWithLineNumbers,
    previousPrompt,
    previousPromptWithLineNumbers,
    promptDiff,
    files: includedFiles,
    sourceFile,
    multi: args.multi,
  });

  if (args.debug) {
    writeToConsole("--- PROMPT ---");
    writeToConsole(evaluatedPrompt);
  }

  if (args.printPrompt || typeof args.writePrompt !== "undefined") {
    if (args.printPrompt) {
      writeToConsole(evaluatedPrompt);
    }

    if (typeof args.writePrompt !== "undefined") {
      // If --write-prompt is specified but no file is mentioned
      if (!args.writePrompt) {
        throw new Error(
          `Specify a file path for the --write-prompt parameter.`
        );
      }

      await writeToFile(args.writePrompt, evaluatedPrompt);
      writeToConsole(`Wrote prompt to ${args.writePrompt}`);
    }

    return;
  }

  const model = args.model || promptSettings?.model || config?.model;

  const maxTokens =
    args.maxTokens || promptSettings?.maxTokens || config?.maxTokens;

  if (args.api !== "openai") {
    throw new Error(
      "Invalid API specified. Only 'openai' is supported currently."
    );
  }

  const completionResult = await openaiCompletion(
    evaluatedPrompt,
    model,
    maxTokens,
    args.debug
  );

  if (completionResult.ok) {
    if (args.write) {
      const extractResult = await extractFilesToDisk(
        args.baseDir || promptFileDir || process.cwd(),
        completionResult,
        args.exec
      );
      const generatedFiles = extractResult.filter((x) => x.generated);
      const skippedFiles = extractResult.filter((x) => !x.generated);

      if (generatedFiles.length) {
        writeToConsole(
          `Generated ${generatedFiles.map((x) => x.file).join(", ")}.`
        );
      }
      if (skippedFiles.length) {
        writeToConsole(
          `Skipped ${skippedFiles.map((x) => x.file).join(", ")}.`
        );
      }
    } else {
      for (const file of completionResult.files) {
        const header = `FILE: ${file.name}`;
        writeToConsole(header);
        writeToConsole("-".repeat(header.length));
        writeToConsole(file.contents);
        writeToConsole();
      }
    }
  } else {
    if (completionResult.error.code === "length") {
      throw new Error(
        "Ran out of tokens. Increase token size by specifying the --max-tokens argument."
      );
    } else {
      throw new Error(
        `${completionResult.error.code}: ${completionResult.error.message}`
      );
    }
  }
}

function removeDuplicates(arr: string[]): string[] {
  return [...new Set(arr)];
}
