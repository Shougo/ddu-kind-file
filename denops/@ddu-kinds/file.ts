import {
  Actions,
  ActionFlags,
  BaseKind,
  DduItem,
} from "https://deno.land/x/ddu_vim@v0.12.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v0.12.0/deps.ts";
import { dirname } from "https://deno.land/std@0.125.0/path/mod.ts";

export type ActionData = {
  bufNr?: number;
  col?: number;
  lineNr?: number;
  path?: string;
  text?: string;
};

type Params = Record<never, never>;

type OpenParams = {
  command: string,
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
          await args.denops.cmd(`buffer ${action.bufNr}`);
        } else {
          const path = action.path ?? item.word;
          if (new RegExp("^https?://").test(path)) {
            // URL
            await args.denops.call("ddu#util#open", path);
            continue;
          }
          await args.denops.call(
            "ddu#util#execute_path", openCommand, path);
        }

        if (action.lineNr != null) {
          await fn.cursor(args.denops, action.lineNr, 0);
        }
        if (action.col != null) {
          await fn.cursor(args.denops, 0, action.col);
        }
      }

      return Promise.resolve(ActionFlags.None);
    },
    cd: async (args: { denops: Denops; items: DduItem[] }) => {
      for (const item of args.items) {
        const action = item?.action as ActionData;

        const path = action.path ?? item.word;
        const dir = (await Deno.stat(path)).isDirectory ? path : dirname(path);
        await args.denops.call("chdir", dir);
      }

      return Promise.resolve(ActionFlags.None);
    },
    quickfix: async (args: { denops: Denops; items: DduItem[] }) => {
      let qfloclist: QuickFix[] = [];

      for (const item of args.items) {
        const action = item?.action as ActionData;

        if (!action.lineNr) {
          continue;
        }

        let qfloc = {
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

      if (qfloclist.length != 0) {
        await fn.setqflist(args.denops, qfloclist, ' ');
        await args.denops.cmd('copen')
      }

      return Promise.resolve(ActionFlags.None);
    },
  };

  params(): Params {
    return {};
  }
}
