import {
  ActionFlags,
  Actions,
  BaseKind,
  Clipboard,
  DduItem,
  DduOptions,
  PreviewContext,
  Previewer,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v1.8.7/types.ts";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "https://deno.land/std@0.149.0/path/mod.ts";
import {
  Denops,
  ensureObject,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v1.8.7/deps.ts";
import { copy, move } from "https://deno.land/std@0.149.0/fs/mod.ts";

export type ActionData = {
  bufNr?: number;
  col?: number;
  isDirectory?: boolean;
  lineNr?: number;
  path?: string;
  text?: string;
};

type Params = Record<never, never>;

type NarrowParams = {
  path: string;
};

type OpenParams = {
  command: string;
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
};

export class Kind extends BaseKind<Params> {
  actions: Actions<Params> = {
    cd: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir != "") {
          const filetype = await op.filetype.getLocal(args.denops);
          await args.denops.call(
            filetype == "deol" ? "deol#cd" : "chdir",
            dir,
          );
        }
      }

      return ActionFlags.None;
    },
    copy: async (
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
    delete: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
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
      if (confirm != 1) {
        return ActionFlags.Persist;
      }

      for (const item of args.items) {
        await Deno.remove(getPath(item), { recursive: true });
      }

      return ActionFlags.RefreshItems;
    },
    executeSystem: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;
        await args.denops.call("ddu#kind#file#open", path);
      }

      return ActionFlags.Persist;
    },
    loclist: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setloclist(args.denops, 0, qfloclist, " ");
        await args.denops.cmd("lopen");
      }

      return ActionFlags.None;
    },
    move: async (
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
    narrow: async (args: {
      denops: Denops;
      actionParams: unknown;
      sourceOptions: SourceOptions;
      items: DduItem[];
    }) => {
      const params = args.actionParams as NarrowParams;
      if (params.path) {
        args.sourceOptions.path = params.path == ".."
          ? resolve(join(args.sourceOptions.path, ".."))
          : params.path;
        return ActionFlags.RefreshItems;
      }

      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir != "") {
          args.sourceOptions.path = dir;
          return ActionFlags.RefreshItems;
        }
      }

      return ActionFlags.None;
    },
    newDirectory: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input a new directory name: ",
        "",
        "dir",
      ) as string;
      if (input == "") {
        return ActionFlags.Persist;
      }

      const newDirectory = isAbsolute(input) ? input : join(cwd, input);

      // Exists check
      if (await exists(newDirectory)) {
        await args.denops.call(
          "ddu#kind#file#print",
          `${newDirectory} already exists.`,
        );
        return ActionFlags.Persist;
      }

      await Deno.mkdir(newDirectory);

      return ActionFlags.RefreshItems;
    },
    newFile: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input",
        cwd,
        "Please input a new file name: ",
        "",
        "file",
      ) as string;
      if (input == "") {
        return ActionFlags.Persist;
      }

      const newFile = isAbsolute(input) ? input : join(cwd, input);

      // Exists check
      if (await exists(newFile)) {
        await args.denops.call(
          "ddu#kind#file#print",
          `${newFile} already exists.`,
        );
        return ActionFlags.Persist;
      }

      if (newFile.slice(-1) == "/") {
        await Deno.mkdir(newFile);
      } else {
        await Deno.writeTextFile(newFile, "");
      }

      return ActionFlags.RefreshItems;
    },
    open: async (args: {
      denops: Denops;
      context: Context;
      actionParams: unknown;
      items: DduItem[];
    }) => {
      const params = args.actionParams as OpenParams;
      const openCommand = params.command ?? "edit";

      for (const item of args.items) {
        const action = item?.action as ActionData;

        if (action.bufNr != null) {
          if (openCommand != "edit") {
            await args.denops.call("ddu#util#execute_path", openCommand, "");
          }
          await args.denops.cmd(`buffer ${action.bufNr}`);
        } else {
          const path = action.path ?? item.word;
          if (new RegExp("^https?://").test(path)) {
            // URL
            await args.denops.call("ddu#kind#file#open", path);
            continue;
          }
          await args.denops.call(
            "ddu#util#execute_path",
            openCommand,
            path,
          );
        }

        if (action.lineNr != null) {
          await fn.cursor(args.denops, action.lineNr, 0);

          if (args.context.input != "") {
            // Search the input text
            const text = (await fn.getline(args.denops, ".")).toLowerCase();
            const input = args.context.input.toLowerCase();
            await fn.cursor(args.denops, 0, text.indexOf(input) + 1);
          }
        }

        if (action.col != null) {
          await fn.cursor(args.denops, 0, action.col);
        }

        // Note: Open folds and centering
        await args.denops.cmd("normal! zvzz");
      }

      return ActionFlags.None;
    },
    paste: async (
      args: {
        denops: Denops;
        items: DduItem[];
        sourceOptions: SourceOptions;
        clipboard: Clipboard;
      },
    ) => {
      const cwd = await getTargetDirectory(
        args.denops,
        args.sourceOptions.path,
        args.items,
      );

      if (args.clipboard.action == "copy") {
        for (const item of args.clipboard.items) {
          const action = item?.action as ActionData;
          const path = action.path ?? item.word;

          const dest = await checkOverwrite(
            args.denops,
            path,
            join(cwd, basename(path)),
          );
          if (dest == "") {
            continue;
          }

          if (await exists(dest)) {
            await Deno.remove(dest, { recursive: true });
          }
          await copy(path, dest, { overwrite: true });
        }
      } else if (args.clipboard.action == "move") {
        for (const item of args.clipboard.items) {
          const action = item?.action as ActionData;
          const path = action.path ?? item.word;
          const dest = await checkOverwrite(
            args.denops,
            path,
            join(cwd, basename(path)),
          );
          if (dest == "") {
            continue;
          }

          if (await exists(dest)) {
            await Deno.remove(dest, { recursive: true });
          }
          await move(path, join(cwd, basename(path)));
        }
      } else {
        await args.denops.call(
          "ddu#kind#file#print",
          `Invalid action: ${args.clipboard.action}`,
        );
        return ActionFlags.Persist;
      }

      return ActionFlags.RefreshItems;
    },
    quickfix: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setqflist(args.denops, qfloclist, " ");
        await args.denops.cmd("copen");
      }

      return ActionFlags.None;
    },
    yank: async (args: { denops: Denops; items: DduItem[] }) => {
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
    rename: async (args: {
      denops: Denops;
      options: DduOptions;
      items: DduItem[];
      sourceOptions: SourceOptions;
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
      if (cwd == "") {
        cwd = await fn.getcwd(args.denops) as string;
      }

      for (const item of args.items) {
        const action = item?.action as ActionData;
        const path = action.path ?? item.word;

        const newPath = await args.denops.call(
          "ddu#kind#file#cwd_input",
          cwd,
          `Please input a new name: ${path} -> `,
          path,
          (await isDirectory(path)) ? "dir" : "file",
        ) as string;

        if (newPath == "" || path == newPath) {
          continue;
        }

        // Exists check
        if (await exists(newPath)) {
          await args.denops.call(
            "ddu#kind#file#print",
            `${newPath} already exists.`,
          );
          return ActionFlags.Persist;
        }

        await Deno.rename(path, newPath);

        await args.denops.call(
          "ddu#kind#file#buffer_rename",
          await fn.bufnr(args.denops, path),
          newPath,
        );
      }

      return ActionFlags.RefreshItems;
    },
    trash: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
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
      if (confirm != 1) {
        return ActionFlags.Persist;
      }

      for (const item of args.items) {
        try {
          const p = Deno.run({
            cmd: ["npx", "trash-cli", getPath(item)],
            stdout: "piped",
            stderr: "piped",
            stdin: "piped",
          });
          await p.status();
        } catch (e) {
          await args.denops.call(
            "ddu#util#print_error",
            'Run "npx trash-cli" is failed.',
          );
          await args.denops.call(
            "ddu#util#print_error",
            '"npx" binary seems not installed.',
          );

          if (e instanceof Error) {
            await args.denops.call(
              "ddu#util#print_error",
              e.message,
            );
          }
        }
      }

      return ActionFlags.RefreshItems;
    },
  };

  // deno-lint-ignore require-await
  async getPreviewer(args: {
    denops: Denops;
    item: DduItem;
    actionParams: unknown;
    previewContext: PreviewContext;
  }): Promise<Previewer | undefined> {
    const action = args.item.action as ActionData;
    if (!action) {
      return undefined;
    }

    const param = ensureObject(args.actionParams) as PreviewOption;

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
      } catch (e) {
        return {
          kind: "nofile",
          contents: ["Error", e.toString()],
          highlights: [{
            name: "ddu-kind-file-error",
            "hl_group": "Error",
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

    return {
      kind: "buffer",
      path: action.bufNr === undefined ? action.path : undefined,
      expr: action.bufNr,
      lineNr: action.lineNr,
    };
  }

  params(): Params {
    return {};
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

  if (dir == "") {
    dir = await fn.getcwd(denops) as string;
  }

  return dir;
};

const getDirectory = async (item: DduItem) => {
  const action = item?.action as ActionData;

  // Note: Deno.stat() may be failed
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

const exists = async (path: string) => {
  // Note: Deno.stat() may be failed
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
  // Note: Deno.stat() may be failed
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (_: unknown) {
    // Ignore stat exception
  }

  return false;
};

const checkOverwrite = async (
  denops: Denops,
  src: string,
  dest: string,
): Promise<string> => {
  if (!(await exists(src))) {
    return "";
  }
  if (!(await exists(dest))) {
    return dest;
  }

  const sStat = await Deno.stat(src);
  const dStat = await Deno.stat(dest);

  const message = ` src: ${src} ${sStat.size} bytes\n` +
    `      ${sStat.mtime?.toISOString()}\n` +
    `dest: ${dest} ${dStat.size} bytes\n` +
    `      ${dStat.mtime?.toISOString()}\n` +
    `${dest} already exists.  Overwrite?`;
  const confirm = await denops.call(
    "ddu#kind#file#confirm",
    message,
    "&Force\n&No\n&Rename\n&Time\n&Underbar",
    0,
  ) as number;

  let ret = "";

  switch (confirm) {
    case 1:
      ret = dest;
      break;
    case 2:
      break;
    case 3:
      ret = await denops.call(
        "ddu#kind#file#cwd_input",
        "",
        `Please input a new name: ${dest} -> `,
        dest,
        (await isDirectory(src)) ? "dir" : "file",
      ) as string;
      break;
    case 4:
      if (dStat.mtime && sStat.mtime && dStat.mtime < sStat.mtime) {
        ret = src;
      }
      break;
    case 5:
      ret = dest + "_";
      break;
  }

  return ret;
};
