import {
  ActionFlags,
  Actions,
  BaseKind,
  DduItem,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v1.5.0/types.ts";
import { Denops, fn, op } from "https://deno.land/x/ddu_vim@v1.5.0/deps.ts";
import { dirname, isAbsolute, join } from "https://deno.land/std@0.135.0/path/mod.ts";

export type ActionData = {
  bufNr?: number;
  col?: number;
  isDirectory?: boolean;
  lineNr?: number;
  path?: string;
  text?: string;
};

type Params = Record<never, never>;

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

      return Promise.resolve(ActionFlags.None);
    },
    narrow: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      for (const item of args.items) {
        const dir = await getDirectory(item);
        if (dir != "") {
          args.sourceOptions.path = dir;
          return Promise.resolve(ActionFlags.RefreshItems);
        }
      }

      return Promise.resolve(ActionFlags.None);
    },
    newDirectory: async (
      args: { denops: Denops; items: DduItem[]; sourceOptions: SourceOptions },
    ) => {
      let cwd = args.sourceOptions.path;
      for (const item of args.items) {
        if (item.__expanded) {
          cwd = await getDirectory(item);
        }
      }

      if (cwd == "") {
        return Promise.resolve(ActionFlags.None);
      }

      const input = await args.denops.call(
        "ddu#kind#file#cwd_input", cwd,
        "Please input a new directory name: ", "", "file") as string;
      const newDirectory = isAbsolute(input) ? input : join(cwd, input);

      await Deno.mkdir(newDirectory);

      return Promise.resolve(ActionFlags.RefreshItems);
    },
    open: async (args: {
      denops: Denops;
      actionParams: unknown;
      items: DduItem[];
    }) => {
      const params = args.actionParams as OpenParams;
      const openCommand = params.command ? params.command : "edit";

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
        }
        if (action.col != null) {
          await fn.cursor(args.denops, 0, action.col);
        }

        // Note: Open folds and centering
        await args.denops.cmd("normal! zvzz");
      }

      return Promise.resolve(ActionFlags.None);
    },
    loclist: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setloclist(args.denops, 0, qfloclist, " ");
        await args.denops.cmd("lopen");
      }

      return Promise.resolve(ActionFlags.None);
    },
    quickfix: async (args: { denops: Denops; items: DduItem[] }) => {
      const qfloclist: QuickFix[] = buildQfLocList(args.items);

      if (qfloclist.length != 0) {
        await fn.setqflist(args.denops, qfloclist, " ");
        await args.denops.cmd("copen");
      }

      return Promise.resolve(ActionFlags.None);
    },
  };

  params(): Params {
    return {};
  }
}

const buildQfLocList = (items: DduItem[]) => {
  const qfloclist: QuickFix[] = [];

  for (const item of items) {
    const action = item?.action as ActionData;

    if (!action.lineNr) {
      continue;
    }

    const qfloc = {
      lnum: action.lineNr,
      text: item.word,
    } as QuickFix;

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
}

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
