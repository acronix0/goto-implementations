import * as vscode from "vscode";
import * as fs from "fs";
import * as dotenv from "dotenv";
import * as path from "path";

class InterfaceCodeLensProvider implements vscode.CodeLensProvider {
  private interfaceStartRegex = /^type\s+(\w+)\s+interface\s*{/;

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const lines = text.split("\n");
    let inInterface = false;
    let interfaceName = "";
    let bracketDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for interface start
      const interfaceMatch = trimmedLine.match(this.interfaceStartRegex);
      if (interfaceMatch) {
        inInterface = true;
        bracketDepth = 1;
        interfaceName = interfaceMatch[1];
        continue;
      }

      if (!inInterface) continue;

      // Update bracket depth
      bracketDepth += (line.match(/{/g) || []).length;
      bracketDepth -= (line.match(/}/g) || []).length;

      // Check for interface end
      if (bracketDepth <= 0) {
        inInterface = false;
        continue;
      }

      // Skip comments and empty lines
      if (trimmedLine.startsWith("//") || trimmedLine === "") {
        continue;
      }

      // Find method signatures
      const methodMatch = trimmedLine.match(/^(\w+)\s*\(/);
      if (methodMatch) {
        const methodName = methodMatch[1];
        const methodPos = line.indexOf(methodName);
        const range = new vscode.Range(
          new vscode.Position(i, methodPos),
          new vscode.Position(i, methodPos + methodName.length)
        );

        codeLenses.push(
          new vscode.CodeLens(range, {
            title: "impls",
            command: "goto-implementations.gotoImplementation",
            arguments: [document.uri, range, methodName],
          })
        );
      }
    }

    return codeLenses;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const codeLensProvider = new InterfaceCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "go", scheme: "file" },
      codeLensProvider
    )
  );

  const disposable = vscode.commands.registerCommand(
    "goto-implementations.gotoImplementation",
    async (uri: vscode.Uri, range: vscode.Range, methodName: string) => {
      console.log(
        `Looking for implementations of ${methodName} at ${uri.path}`
      );
      try {
        const implementations = await vscode.commands.executeCommand<
          vscode.Location[]
        >("vscode.executeImplementationProvider", uri, range.start);

        console.log(`Found ${implementations?.length} implementations`);

        if (implementations && implementations.length > 0) {
          const items = await Promise.all(
            implementations.map(async (loc) => {
              const doc = await vscode.workspace.openTextDocument(loc.uri);
              const text = doc.getText(loc.range);
              const preview = text.trim().split("\n")[0];
              const relativePath = vscode.workspace.asRelativePath(loc.uri);
              const isMock = loc.uri.fsPath.toLowerCase().includes("mock");

              return {
                label: `${isMock ? "🧪 MOCK" : "🔧 IMPL"} — ${preview}`,
                detail: relativePath,
                description: isMock
                  ? "Mock implementation"
                  : "Real implementation",
                location: loc,
                isMock: isMock,
              };
            })
          );

          items.sort((a, b) => Number(a.isMock) - Number(b.isMock));

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select implementation of ${methodName}`,
          });

          if (selected) {
            await vscode.window.showTextDocument(selected.location.uri, {
              selection: selected.location.range,
            });
          }
        } else {
          vscode.window.showInformationMessage(
            `No implementations found for ${methodName}`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          "Error while finding implementations: " + error
        );
      }
    }
  );

  const debugWithEnv = vscode.commands.registerCommand(
    "goto-implementations.debugWithEnv",
    async () => {
      try {
        const mainFiles = await vscode.workspace.findFiles(
          "**/main.go",
          "**/node_modules/**",
          1
        );
        if (mainFiles.length === 0) {
          vscode.window.showErrorMessage("main.go не найден в проекте");
          return;
        }

        const programPath = path.dirname(mainFiles[0].fsPath);
        const candidateEnvPath = path.join(programPath, ".env");

        let envPath = "";
        if (fs.existsSync(candidateEnvPath)) {
          envPath = candidateEnvPath;
        } else {
          const envFiles = await vscode.workspace.findFiles(
            "**/.env",
            "**/node_modules/**",
            1
          );
          if (envFiles.length === 0) {
            vscode.window.showErrorMessage(
              ".env файл не найден рядом с main.go или в проекте"
            );
            return;
          }
          envPath = envFiles[0].fsPath;
        }

        const envRaw = dotenv.parse(fs.readFileSync(envPath));
        const patchedEnv: Record<string, string> = {};

        for (const key in envRaw) {
          const val = envRaw[key];
          if (/LISTEN|ADDR|HOST/.test(key) && /^:\d+$/.test(val)) {
            patchedEnv[key] = "0.0.0.0" + val;
          } else {
            patchedEnv[key] = val;
          }
        }

        const success = await vscode.debug.startDebugging(undefined, {
          name: "Go Debug with .env",
          type: "go",
          request: "launch",
          mode: "auto",
          program: programPath,
          env: patchedEnv,
        });

        if (!success) {
          vscode.window.showErrorMessage("Не удалось запустить отладчик.");
        }
      } catch (err) {
        vscode.window.showErrorMessage("Ошибка при запуске отладчика: " + err);
      }
    }
  );

  context.subscriptions.push(disposable, debugWithEnv);
}

export function deactivate() {}
