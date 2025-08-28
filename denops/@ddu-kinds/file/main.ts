import {
  ActionFlags,
  type ActionHistory,
  type Actions,
  type BaseParams,
  type Clipboard,
  type Context,
  type DduItem,
  type DduOptions,
  type PreviewContext,
  type Previewer,
  type SourceOptions,
} from "@shougo/ddu-vim/types";
import { BaseKind } from "@shougo/ddu-vim/kind";
import {
  printError,
  treePath2Filename,
} from "@shougo/ddu-vim/utils";

import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";

import { basename } from "@std/path/basename";
import { dirname } from "@std/path/dirname";
import { isAbsolute } from "@std/path/is-absolute";
import { join } from "@std/path/join";
import { normalize } from "@std/path/normalize";
import { relative } from "@std/path/relative";
import { copy } from "@std/fs/copy";
import { ensureDir } from "@std/fs/ensure-dir";
import { ensureFile } from "@std/fs/ensure-file";
import { move } from "@std/fs/move";
import { ByteSliceStream } from "@std/streams/byte-slice-stream";
import { toArrayBuffer } from "@std/streams/to-array-buffer";
import { TextLineStream } from "@std/streams/text-line-stream";
import { ensure as unknownEnsure } from "@core/unknownutil/ensure";
import { is } from "@core/unknownutil/is";

export type ActionData = {
  bufNr?: number;
  col?: number;
  isDirectory?: boolean;
  isLink?: boolean;
  lineNr?: number;
  path?: string;
  text?: string;
};

export const FileActions: Actions<Params> = {
  append: {
    description: "Paste the path like |p|.",
    callback: async (
      args: { denops: Denops; context: Context; items: DduItem[] },
    ) => {
      for (const item of args.items) {
        await paste(args.denops, item, "p");
      }
      return ActionFlags.None;
    },
  },
  cd: {
    description: "Call |chdir()| the directory.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir === "") {
          await printError(
            args.denops,
            `${dir} is not found.`,
          );

          continue;
        }

        await args.denops.call(
          "chdir",
          dir,
        );
      }

      return ActionFlags.None;
    },
  },
  clipCopy: {
    description: "Copy files from clipboard register.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        clipboard: Clipboard;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        treePath2Filename(args.sourceOptions.path),
        args.items,
      );

      const clipboard = await fn.getreg(args.denops, "+") as string;
      let defaultConfirm = "";
      let searchPath = "";
      for (const path of clipboard.split("\n")) {
        const ret = await checkOverwrite(
          args.denops,
          path,
          join(cwd, basename(path)),
          defaultConfirm,
        );
        const dest = ret.dest;
        defaultConfirm = ret.defaultConfirm;
        if (dest === "") {
          continue;
        }

        await safeAction("copy", path, dest);

        searchPath = dest;
      }

      if (searchPath === "") {
        return ActionFlags.Persist;
      } else {
        return {
          flags: ActionFlags.RefreshItems,
          searchPath,
        };
      }
    },
  },
  clipMove: {
    description: "Move files from clipboard register.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        clipboard: Clipboard;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        treePath2Filename(args.sourceOptions.path),
        args.items,
      );

      const clipboard = await fn.getreg(args.denops, "+") as string;
      let defaultConfirm = "";
      let searchPath = "";
      for (const path of clipboard.split("\n")) {
        const ret = await checkOverwrite(
          args.denops,
          path,
          join(cwd, basename(path)),
          defaultConfirm,
        );
        const dest = ret.dest;
        defaultConfirm = ret.defaultConfirm;
        if (dest === "") {
          continue;
        }

        await safeAction("move", path, dest);

        searchPath = dest;
      }

      if (searchPath === "") {
        return ActionFlags.Persist;
      } else {
        return {
          flags: ActionFlags.RefreshItems,
          searchPath,
        };
      }
    },
  },
  clipYank: {
    description: "Yank the file path to clipboard register.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      const paths = args.items.map((item) => {
        const action = item?.action as ActionData;
        return action.path ?? item.word;
      });

      await fn.setreg(args.denops, "+", paths.join("\n"), "v");

      return ActionFlags.Persist;
    },
  },
  copy: {
    description: "Copy the selected files to ddu clipboard.",
    callback: async (
      args: { denops: Denops; items: DduItem[]; clipboard: Clipboard },
    ) => {
      const message = `Copy to the clipboard: ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }`;

      await args.denops.call("ddu#kind#file#print", message);

      args.clipboard.action = "copy";
      args.clipboard.items = args.items;
      args.clipboard.mode = "";

      return ActionFlags.Persist;
    },
  },
  delete: {
    description: "Delete the file or directory.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const message = `Are you sure you want to delete ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }?`;

      const confirm = await args.denops.call(
        "ddu#kind#file#confirm",
        message,
        "&Yes\n&No\n&Cancel",
        2,
      ) as number;
      if (confirm !== 1) {
        return ActionFlags.Persist;
      }

      args.actionHistory.actions = [];
      let searchPath = "";
      for (const item of args.items) {
        const itemPath = getPath(item);

        searchPath = dirname(itemPath);

        await Deno.remove(itemPath, { recursive: true });

        await args.denops.call(
          "ddu#kind#file#buffer_delete",
          await fn.bufnr(args.denops, itemPath),
        );

        args.actionHistory.actions.push({
          name: "delete",
          item,
        });
      }

      return {
        flags: ActionFlags.RefreshItems,
        searchPath,
      };
    },
  },
  execute: {
    description: "Execute the file.",
    callback: async (
      args: {
        denops: Denops;
        actionParams: BaseParams;
        items: DduItem[];
        sourceOptions: SourceOptions;
      },
    ) => {
      const params = args.actionParams as ExecuteParams;
      const command = params.command ?? "edit";

      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        await args.denops.call(
          "ddu#util#execute_path",
          command,
          path,
        );
      }

      return ActionFlags.None;
    },
  },
  executeSystem: {
    description: "Execute the file by system associated command.",
    callback: async (
      args: {
        denops: Denops;
        actionParams: BaseParams;
        items: DduItem[];
        sourceOptions: SourceOptions;
      },
    ) => {
      const params = args.actionParams as ExecuteSystemParams;
      const method = params.method ?? "";

      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;
        await args.denops.call("ddu#kind#file#open", path, method);
      }

      return ActionFlags.Persist;
    },
  },
  feedkeys: {
    description:
      "Use |feedkeys()| to insert the path.\nIt is useful in command line mode.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        await feedkeys(args.denops, item);
      }
      return ActionFlags.None;
    },
  },
  insert: {
    description: "Paste the path like |P|.",
    callback: async (
      args: { denops: Denops; context: Context; items: DduItem[] },
    ) => {
      for (const item of args.items) {
        await paste(args.denops, item, "P");
      }
      return ActionFlags.None;
    },
  },
  link: {
    description: "Create link the selected files to ddu clipboard.",
    callback: async (args: {
      denops: Denops;
      actionParams: BaseParams;
      items: DduItem[];
      clipboard: Clipboard;
    }) => {
      const params = args.actionParams as LinkParams;
      const mode = params.mode ?? "absolute";
      const message = `Link to the clipboard: ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }`;

      await args.denops.call("ddu#kind#file#print", message);

      args.clipboard.action = "link";
      args.clipboard.items = args.items;
      args.clipboard.mode = mode;

      return ActionFlags.Persist;
    },
  },
  loclist: {
    description: "Set the |location-list| and open the |location-list| window.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length !== 0) {
        await fn.setloclist(args.denops, 0, qfloclist, " ");
        await args.denops.cmd("lopen");
      }

      return ActionFlags.None;
    },
  },
  move: {
    description: "Move the selected files to ddu clipboard.",
    callback: async (
      args: { denops: Denops; items: DduItem[]; clipboard: Clipboard },
    ) => {
      const message = `Move to the clipboard: ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }`;

      await args.denops.call("ddu#kind#file#print", message);

      args.clipboard.action = "move";
      args.clipboard.items = args.items;
      args.clipboard.mode = "";

      return ActionFlags.Persist;
    },
  },
  narrow: {
    description: "Change |ddu-source-option-path| to the directory.",
    callback: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: BaseParams;
      sourceOptions: SourceOptions;
      items: DduItem[];
    }) => {
      const params = args.actionParams as NarrowParams;
      if (params.path) {
        if (params.path === "..") {
          let current = treePath2Filename(args.sourceOptions.path);
          if (current === "") {
            current = await fn.getcwd(args.denops) as string;
          }
          args.sourceOptions.path = normalize(join(current, ".."));
          return {
            flags: ActionFlags.RefreshItems,
            searchPath: current,
          };
        } else {
          args.sourceOptions.path = params.path;
          return ActionFlags.RefreshItems;
        }
      }

      if (args.items.length > 1) {
        await args.denops.call("ddu#start", {
          name: args.options.name,
          push: true,
          sources: await Promise.all(args.items.map(async (item) => {
            return {
              name: "file",
              options: {
                columns: args.sourceOptions.columns,
                path: await getDirectory(item),
              },
            };
          })),
        });

        return ActionFlags.None;
      }

      const dir = await getDirectory(args.items[0]);
      if (dir !== "") {
        args.sourceOptions.path = dir;
        return ActionFlags.RefreshItems;
      }

      return ActionFlags.None;
    },
  },
  newDirectory: {
    description:
      "Make new directory in expanded directory tree or current directory.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        treePath2Filename(args.sourceOptions.path),
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input directory names(comma separated): ",
        "",
        "dir",
      ) as string;
      if (input === "") {
        return ActionFlags.Persist;
      }

      let newDirectory = "";

      args.actionHistory.actions = [];
      for (const name of input.split(",")) {
        newDirectory = isAbsolute(name) ? name : join(cwd, name);

        // Exists check
        if (await exists(newDirectory)) {
          await args.denops.call(
            "ddu#kind#file#print",
            `${newDirectory} already exists.`,
          );

          continue;
        }

        await ensureDir(newDirectory);

        args.actionHistory.actions.push({
          name: "newDirectory",
          dest: newDirectory,
        });
      }

      if (newDirectory === "") {
        return ActionFlags.Persist;
      }

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newDirectory,
      };
    },
  },
  newFile: {
    description:
      "Make new file in expanded directory tree or current directory.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        treePath2Filename(args.sourceOptions.path),
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input names(comma separated): ",
        "",
        "file",
      ) as string;
      if (input === "") {
        return ActionFlags.Persist;
      }

      let newFile = "";

      args.actionHistory.actions = [];
      for (const name of input.split(",")) {
        newFile = isAbsolute(name) ? name : join(cwd, name);

        // Exists check
        if (await exists(newFile)) {
          await args.denops.call(
            "ddu#kind#file#print",
            `${newFile} already exists.`,
          );
          continue;
        }

        if (newFile.slice(-1) === "/") {
          await ensureDir(newFile);
        } else {
          await ensureFile(newFile);
        }

        args.actionHistory.actions.push({
          name: "newFile",
          dest: newFile,
        });
      }

      if (newFile === "") {
        return ActionFlags.Persist;
      }

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newFile,
      };
    },
  },
  open: {
    description:
      "Open the items.\nIf the item is buffer, switch to the buffer.\n" +
      "If the item is file, open the file.",
    callback: async (args: {
      denops: Denops;
      context: Context;
      actionParams: BaseParams;
      items: DduItem[];
    }) => {
      const params = args.actionParams as OpenParams;
      const openCommand = params.command ?? "edit";

      // Save current position.
      await args.denops.cmd("normal! m`");

      for (const item of args.items) {
        const action = item?.action as ActionData;
        const bufNr = action.bufNr ??
          await args.denops.call(
            "ddu#kind#file#bufnr",
            action.path ?? item.word,
          ) as number;

        if (bufNr >= 0) {
          if (openCommand !== "edit") {
            await args.denops.call(
              "ddu#util#execute_path",
              openCommand,
              action.path ?? "",
            );
          }

          // NOTE: "bufNr" may be hidden
          const loaded = await fn.bufloaded(args.denops, bufNr);
          if (!loaded) {
            await fn.bufload(args.denops, bufNr);
          }
          await args.denops.cmd(`buffer ${bufNr}`);
          if (!loaded) {
            await fn.setbufvar(args.denops, bufNr, "&buflisted", 1);
          }
        } else if (action.path) {
          // Check the file is binary file or too big.
          const stat = await safeStat(action.path);
          if (stat && stat.isDirectory) {
            await args.denops.call(
              "ddu#kind#file#print",
              `${action.path} is directory.`,
            );
            continue;
          }

          if (stat && await isBinary(action.path, stat)) {
            const confirm = await args.denops.call(
              "ddu#kind#file#confirm",
              `"${action.path}" has binary code.  Opening?`,
              "&Yes\n&No\n&Cancel",
              2,
            ) as number;
            if (confirm !== 1) {
              continue;
            }
          }

          const maxSize = params.maxSize ?? 500000;
          if (stat && stat.size > maxSize) {
            const confirm = await args.denops.call(
              "ddu#kind#file#confirm",
              `"${action.path}" ${stat.size} bytes are too huge.  Opening?`,
              "&Yes\n&No\n&Cancel",
              2,
            ) as number;
            if (confirm !== 1) {
              continue;
            }
          }

          await args.denops.call(
            "ddu#util#execute_path",
            openCommand,
            action.path,
          );
        }

        const mode = await fn.mode(args.denops);
        if (action.lineNr !== undefined) {
          await fn.cursor(args.denops, action.lineNr, 0);

          if (args.context.input !== "") {
            // Search the input text
            const text = (await fn.getline(args.denops, ".")).toLowerCase();
            const input = args.context.input.toLowerCase();
            await fn.cursor(
              args.denops,
              0,
              text.indexOf(input) + 1 + (mode === "i" ? 1 : 0),
            );
          }
        }

        if (action.col !== undefined) {
          // If it is insert mode, it needs adjust.
          await fn.cursor(
            args.denops,
            0,
            action.col + (mode === "i" ? 1 : 0),
          );
        }

        // NOTE: Open folds and centering
        await args.denops.cmd("normal! zvzz");
      }

      return ActionFlags.None;
    },
  },
  paste: {
    description: "Fire the clipboard action in the current directory.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        clipboard: Clipboard;
        actionHistory: ActionHistory;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        treePath2Filename(args.sourceOptions.path),
        args.items,
      );

      let searchPath = "";
      let defaultConfirm = "";
      args.actionHistory.actions = [];
      switch (args.clipboard.action) {
        case "copy":
        case "move":
        case "link":
          for (const item of args.clipboard.items) {
            const action = item?.action as ActionData;
            const path = action.path ?? item.word;

            const ret = await checkOverwrite(
              args.denops,
              path,
              join(cwd, basename(path)),
              defaultConfirm,
            );
            const dest = ret.dest;
            defaultConfirm = ret.defaultConfirm;
            if (dest === "") {
              continue;
            }

            if (args.clipboard.action === "link") {
              // Exists check
              if (await exists(dest)) {
                await args.denops.call(
                  "ddu#kind#file#print",
                  `${dest} already exists.`,
                );
                return ActionFlags.Persist;
              }

              switch (args.clipboard.mode) {
                case "hard":
                  await Deno.link(path, dest);
                  break;
                case "absolute":
                  await Deno.symlink(path, dest, {
                    type: await isDirectory(path) ? "dir" : "file",
                  });
                  break;
                case "relative":
                  await Deno.symlink(relative(path, dirname(dest)), dest, {
                    type: await isDirectory(path) ? "dir" : "file",
                  });
                  break;
                default:
                  await args.denops.call(
                    "ddu#kind#file#print",
                    `Invalid mode: ${args.clipboard.mode}`,
                  );
                  return ActionFlags.Persist;
              }
            } else {
              await safeAction(args.clipboard.action, path, dest);

              if (args.clipboard.action === "move") {
                await args.denops.call(
                  "ddu#kind#file#buffer_rename",
                  await fn.bufnr(args.denops, path),
                  dest,
                );
              }
            }

            searchPath = dest;

            args.actionHistory.actions.push({
              name: args.clipboard.action,
              item,
              dest,
            });
          }
          break;
        default:
          await args.denops.call(
            "ddu#kind#file#print",
            `Invalid action: ${args.clipboard.action}`,
          );
          return ActionFlags.Persist;
      }

      if (searchPath === "") {
        return ActionFlags.Persist;
      } else {
        return {
          flags: ActionFlags.RefreshItems,
          searchPath,
        };
      }
    },
  },
  quickfix: {
    description: "Set the |quickfix| list and open the |quickfix| window.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length !== 0) {
        await fn.setqflist(args.denops, qfloclist, " ");
        await args.denops.cmd("copen");
      }

      return ActionFlags.None;
    },
  },
  rename: {
    description:
      "Rename the file/directory under cursor or from selected list.",
    callback: async (args: {
      denops: Denops;
      options: DduOptions;
      items: DduItem[];
      sourceOptions: SourceOptions;
      actionHistory: ActionHistory;
    }) => {
      if (args.items.length > 1) {
        // Use exrename instead
        await args.denops.call(
          "ddu#kind#file#exrename#create_buffer",
          args.items.map((item) => {
            return {
              action__path: (item?.action as ActionData).path ?? item.word,
            };
          }),
          {
            name: args.options.name,
          },
        );

        return ActionFlags.Persist;
      }

      let cwd = args.sourceOptions.path;
      if (cwd === "") {
        cwd = await fn.getcwd(args.denops) as string;
      }

      let newPath = "";
      args.actionHistory.actions = [];
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        newPath = await args.denops.call(
          "ddu#kind#file#cwd_input",
          cwd,
          `Please input a new name: ${path} -> `,
          path,
          (await isDirectory(path)) ? "dir" : "file",
        ) as string;

        if (newPath === "" || path === newPath) {
          continue;
        }

        await safeAction("rename", path, newPath);

        await args.denops.call(
          "ddu#kind#file#buffer_rename",
          await fn.bufnr(args.denops, path),
          newPath,
        );

        args.actionHistory.actions.push({
          name: "rename",
          item,
          dest: newPath,
        });
      }

      return {
        flags: ActionFlags.RefreshItems,
        searchPath: newPath,
      };
    },
  },
  trash: {
    description: "Move the file or directory to the trash.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        kindParams: Params;
        actionHistory: ActionHistory;
      },
    ) => {
      const message = `Are you sure you want to move to the trash ${
        args.items.length > 1
          ? args.items.length + " files"
          : getPath(args.items[0])
      }?`;

      const confirm = await args.denops.call(
        "ddu#kind#file#confirm",
        message,
        "&Yes\n&No\n&Cancel",
        2,
      ) as number;
      if (confirm !== 1) {
        return ActionFlags.Persist;
      }

      const trashCommand = args.kindParams.trashCommand;

      if (!await fn.executable(args.denops, trashCommand[0])) {
        await printError(
          args.denops,
          `${trashCommand[0]} is not found.`,
        );
        return ActionFlags.Persist;
      }

      args.actionHistory.actions = [];
      for (const item of args.items) {
        const cmd = Array.from(trashCommand);
        cmd.push(getPath(item));
        const proc = new Deno.Command(
          cmd[0],
          {
            args: cmd.slice(1),
            stdout: "null",
            stderr: "piped",
            stdin: "null",
          },
        ).spawn();

        proc.status.then(async (s) => {
          if (s.success) {
            await args.denops.call(
              "ddu#kind#file#buffer_delete",
              await fn.bufnr(args.denops, getPath(item)),
            );
            return;
          }

          await printError(
            args.denops,
            `Run ${cmd} is failed with exit code ${s.code}.`,
          );
          const err = [];
          for await (const line of iterLine(proc.stderr)) {
            err.push(line);
          }
          await printError(
            args.denops,
            err.join("\n"),
          );
        });

        args.actionHistory.actions.push({
          name: "trash",
          item,
        });
      }

      return ActionFlags.RefreshItems;
    },
  },
  undo: {
    description: "Undo the previous action.",
    callback: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        actionHistory: ActionHistory;
      },
    ) => {
      if (args.actionHistory.actions.length === 0) {
        return ActionFlags.Persist;
      }

      let searchPath = "";

      const actions: typeof args.actionHistory.actions = [];

      const message = `Are you sure you want to undo ${
        args.actionHistory.actions.map(
          (action) => action.name + ":" + action.dest,
        )
      } ${args.actionHistory.actions.length > 1 ? "actions" : "action"}?`;

      const confirm = await args.denops.call(
        "ddu#kind#file#confirm",
        message,
        "&Yes\n&No\n&Cancel",
        2,
      ) as number;
      if (confirm !== 1) {
        return ActionFlags.Persist;
      }

      for (const action of args.actionHistory.actions.reverse()) {
        switch (action.name) {
          case "copy":
          case "link":
          case "newDirectory":
          case "newFile":
            if (action.dest) {
              await Deno.remove(action.dest, { recursive: true });

              actions.push({
                name: "delete",
                item: action.item,
              });
            }
            break;
          case "move":
          case "rename":
            if (action.dest && action.item) {
              await move(
                action.dest,
                getPath(action.item),
              );
              searchPath = getPath(action.item);

              actions.push({
                name: action.name,
                dest: getPath(action.item),
                item: {
                  ...action.item,
                  word: action.dest,
                  action: {
                    path: action.dest,
                  },
                  treePath: action.dest,
                },
              });
            }
            break;
          default:
            await args.denops.call(
              "ddu#kind#file#print",
              `Cannot undo action: ${action.name}`,
            );
            return ActionFlags.Persist;
        }
      }

      // Clear
      args.actionHistory.actions = actions;

      return {
        flags: ActionFlags.RefreshItems,
        searchPath,
      };
    },
  },
  yank: {
    description: "Yank the file path to unnamed register.",
    callback: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        await fn.setreg(args.denops, '"', path, "v");
        await fn.setreg(
          args.denops,
          await vars.v.get(args.denops, "register"),
          path,
          "v",
        );
      }

      return ActionFlags.Persist;
    },
  },
};

type Params = {
  trashCommand: string[];
};

type NarrowParams = {
  path: string;
};

type ExecuteParams = {
  command: string;
};

type ExecuteSystemParams = {
  method: string;
};

type OpenParams = {
  command: string;
  maxSize?: number;
};

type LinkParams = {
  mode: "hard" | "absolute" | "relative";
};

type QuickFix = {
  lnum: number;
  text: string;
  col?: number;
  bufnr?: number;
  filename?: string;
};

type PreviewOption = {
  previewCmds?: string[];
  maxSize?: number;
};

export class Kind extends BaseKind<Params> {
  override actions = FileActions;

  override async getPreviewer(args: {
    denops: Denops;
    item: DduItem;
    actionParams: BaseParams;
    previewContext: PreviewContext;
  }): Promise<Previewer | undefined> {
    const action = args.item.action as ActionData;
    if (!action) {
      return undefined;
    }

    const param = unknownEnsure(args.actionParams, is.Record) as PreviewOption;

    if (action.path && param.previewCmds?.length) {
      const previewHeight = args.previewContext.height;
      let startLine = 0;
      let lineNr = 0;
      if (action.lineNr) {
        lineNr = action.lineNr;
        startLine = Math.max(
          0,
          Math.ceil(action.lineNr - previewHeight / 2),
        );
      }

      const pairs: Record<string, string> = {
        s: action.path,
        l: String(lineNr),
        h: String(previewHeight),
        e: String(startLine + previewHeight),
        b: String(startLine),
        "%": "%",
      };
      const replacer = (
        match: string,
        p1: string,
      ) => {
        if (!p1.length || !(p1 in pairs)) {
          throw `invalid item ${match}`;
        }
        return pairs[p1];
      };
      const replaced: string[] = [];
      try {
        for (const cmd of param.previewCmds) {
          replaced.push(cmd.replace(/%(.?)/g, replacer));
        }
      } catch (e: unknown) {
        return {
          kind: "nofile",
          contents: e?.toString ? ["Error", e.toString()] : [],
          highlights: [{
            name: "ddu-kind-file-error",
            hl_group: "Error",
            row: 1,
            col: 1,
            width: 5,
          }],
        };
      }

      return {
        kind: "terminal",
        cmds: replaced,
      };
    }

    // File path check
    if (action.path) {
      const stat = await safeStat(action.path);
      if (stat && stat.isDirectory) {
        // Directory.
        return {
          kind: "nofile",
          contents: [`${action.path} is directory`],
        };
      }

      if (stat && await isBinary(action.path, stat)) {
        // Binary file.
        return {
          kind: "nofile",
          contents: [`${action.path} is binary file`],
        };
      }

      const maxSize = param.maxSize ?? 500000;
      if (stat && stat.size > maxSize) {
        // Over maxSize file.
        return {
          kind: "nofile",
          contents: [`${action.path} is over maxSize.`],
        };
      }
    }

    if (action.bufNr) {
      // NOTE: buffer may be hidden
      await fn.bufload(args.denops, action.bufNr);
    }

    return {
      kind: "buffer",
      path: action.bufNr ? undefined : action.path,
      expr: action.bufNr,
      lineNr: action.lineNr,
    };
  }

  override params(): Params {
    return {
      trashCommand: ["gio", "trash"],
    };
  }
}

const buildQfLocList = (items: DduItem[]) => {
  const qfloclist: QuickFix[] = [];

  for (const item of items) {
    const action = item?.action as ActionData;

    const qfloc = {
      text: item.word,
    } as QuickFix;

    if (action.lineNr) {
      qfloc.lnum = action.lineNr;
    }
    if (action.col) {
      qfloc.col = action.col;
    }
    if (action.bufNr) {
      qfloc.bufnr = action.bufNr;
    }
    if (action.path) {
      qfloc.filename = action.path;
    }
    if (action.text) {
      qfloc.text = action.text;
    }

    qfloclist.push(qfloc);
  }

  return qfloclist;
};

const getTargetDirectory = async (
  denops: Denops,
  initPath: string,
  items: DduItem[],
) => {
  let dir = initPath;
  for (const item of items) {
    const action = item?.action as ActionData;
    const path = action.path ?? item.word;

    dir = item.__expanded ? path : dirname(path);
  }

  if (dir === "") {
    dir = await fn.getcwd(denops) as string;
  }

  return dir;
};

const getDirectory = async (item: DduItem) => {
  const action = item?.action as ActionData;

  // NOTE: Deno.stat() may be failed
  try {
    const path = action.path ?? item.word;
    const dir = (action.isDirectory ?? (await Deno.stat(path)).isDirectory)
      ? path
      : dirname(path);
    if ((await Deno.stat(dir)).isDirectory) {
      return dir;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return "";
};

const getPath = (item: DduItem) => {
  const action = item?.action as ActionData;
  return action.path ?? item.word;
};

const safeStat = async (path: string): Promise<Deno.FileInfo | null> => {
  // NOTE: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    return stat;
  } catch (_: unknown) {
    // Ignore stat exception
  }
  return null;
};

const exists = async (path: string) => {
  // NOTE: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    if (stat.isDirectory || stat.isFile || stat.isSymlink) {
      return true;
    }
  } catch (_: unknown) {
    // Ignore stat exception
  }

  return false;
};

const isDirectory = async (path: string) => {
  // NOTE: Deno.stat() may be failed
  try {
    if ((await Deno.stat(path)).isDirectory) {
      return true;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return false;
};

const isBinary = async (
  path: string,
  stat: Deno.FileInfo,
): Promise<boolean> => {
  if (!stat.isFile || stat.size === 0) {
    return false;
  }

  const file = await Deno.open(path, { read: true });
  const rangedStream = file.readable
    .pipeThrough(
      new ByteSliceStream(
        0,
        Math.min(stat.size, 256) - 1,
      ),
    );
  const range = await toArrayBuffer(rangedStream);
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(range);

  // deno-lint-ignore no-control-regex
  return text.match(/[\x00-\x08\x10-\x1a\x1c-\x1f]{2,}/) !== null;
};

const checkOverwrite = async (
  denops: Denops,
  src: string,
  dest: string,
  defaultConfirm: string,
): Promise<{ dest: string; defaultConfirm: string }> => {
  const sStat = await safeStat(src);
  const dStat = await safeStat(dest);

  if (!sStat) {
    return { dest: "", defaultConfirm: "" };
  }
  if (!dStat) {
    return { dest, defaultConfirm: "" };
  }

  const message = ` src: ${src} ${sStat.size} bytes\n` +
    `      ${sStat.mtime?.toISOString()}\n` +
    `dest: ${dest} ${dStat.size} bytes\n` +
    `      ${dStat.mtime?.toISOString()}\n` +
    `${dest} already exists.  Overwrite? (Upper case is all)\n` +
    "f[orce]/t[ime]/u[nderbar]/n[o]/r[ename] : ";

  // NOTE: Uppercase defaultConfirm skips user input
  const confirm =
    (defaultConfirm !== "" && defaultConfirm.toLowerCase() !== defaultConfirm)
      ? defaultConfirm
      : await denops.call(
        "ddu#kind#file#check_overwrite_method",
        message,
        "no",
      ) as string;

  let ret = "";

  switch (confirm.toLowerCase()) {
    case "f":
      ret = dest;
      break;
    case "n":
      break;
    case "r":
      ret = await denops.call(
        "ddu#kind#file#cwd_input",
        "",
        `Please input a new name: ${dest} -> `,
        dest,
        sStat.isDirectory ? "dir" : "file",
      ) as string;
      if (ret === dest) {
        ret = "";
      }
      break;
    case "t":
      if (dStat.mtime && sStat.mtime && dStat.mtime < sStat.mtime) {
        ret = src;
      }
      break;
    case "u":
      ret = dest + "_";
      break;
  }

  return { dest: ret, defaultConfirm: confirm };
};

const paste = async (denops: Denops, item: DduItem, pasteKey: string) => {
  const action = item?.action as ActionData;

  if (action.path === null) {
    return;
  }

  const oldReg = await fn.getreginfo(denops, '"');

  await fn.setreg(denops, '"', action.path, "v");
  try {
    await denops.cmd('normal! ""' + pasteKey);
  } finally {
    await fn.setreg(denops, '"', oldReg);
  }

  // Open folds
  await denops.cmd("normal! zv");
};

const feedkeys = async (denops: Denops, item: DduItem) => {
  const action = item?.action as ActionData;

  if (action.path === null) {
    return;
  }

  // Use feedkeys() instead
  await fn.feedkeys(denops, action.path, "n");
};

const safeAction = async (
  action: "rename" | "move" | "copy",
  src: string,
  dest: string,
) => {
  // Exists check
  if (action !== "copy" && await exists(dest)) {
    // NOTE: "src" may be same with "dest".  Rename is needed.
    const temp = src + "___";

    await Deno.rename(src, temp);

    // NOTE: if src === dest, it may be not exists
    if (await exists(dest)) {
      await Deno.remove(dest, { recursive: true });
    }

    src = temp;
  }

  if (!await exists(dirname(dest))) {
    return;
  }

  switch (action) {
    case "rename":
      await Deno.rename(src, dest);
      break;
    case "move":
      await move(src, dest);
      break;
    case "copy":
      await copy(src, dest, { overwrite: true });
      break;
  }
};

async function* iterLine(r: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const lines = r
    .pipeThrough(new TextDecoderStream(), {
      preventCancel: false,
      preventClose: false,
    })
    .pipeThrough(new TextLineStream());

  for await (const line of lines) {
    if ((line as string).length) {
      yield line as string;
    }
  }
}
