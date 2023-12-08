let s:is_windows = has('win32') || has('win64')

function! ddu#kind#file#open(filename) abort
  let filename = a:filename->fnamemodify(':p')

  if has('nvim-0.10')
    " Use vim.ui.open instead
    call v:lua.vim.ui.open(filename)
    return
  endif

  let is_cygwin = has('win32unix')
  let is_mac = !s:is_windows && !is_cygwin
        \ && (has('mac') || has('macunix') || has('gui_macvim') ||
        \   (!('/proc'->isdirectory()) && 'sw_vers'->executable()))
  let is_wsl = s:check_wsl()

  " Detect desktop environment.
  if s:is_windows
    " For URI only.
    " Note:
    "   # and % required to be escaped (:help cmdline-special)
    silent execute printf(
          \ '!start rundll32 url.dll,FileProtocolHandler %s',
          \ filename->escape('#%'),
          \)
  elseif is_cygwin
    " Cygwin.
    call system(printf('%s %s', 'cygstart',
          \ filename->shellescape()))
  elseif 'xdg-open'->executable()
    " Linux.
    call system(printf('%s %s &', 'xdg-open',
          \ filename->shellescape()))
  elseif 'lemonade'->executable()
    call system(printf('%s %s &', 'lemonade open',
          \ filename->shellescape()))
  elseif '$KDE_FULL_SESSION'->exists() && $KDE_FULL_SESSION ==# 'true'
    " KDE.
    call system(printf('%s %s &', 'kioclient exec',
          \ filename->shellescape()))
  elseif exists('$GNOME_DESKTOP_SESSION_ID')
    " GNOME.
    call system(printf('%s %s &', 'gnome-open',
          \ filename->shellescape()))
  elseif 'exo-open'->executable()
    " Xfce.
    call system(printf('%s %s &', 'exo-open',
          \ filename->shellescape()))
  elseif is_mac && executable('open')
    " Mac OS.
    call system(printf('%s %s &', 'open',
          \ filename->shellescape()))
  elseif is_wsl && 'cmd.exe'->executable()
    " WSL and not installed any open commands

    " Open the same way as Windows.
    " I don't know why, but the method using execute requires redraw <C-l>
    " after execution in vim.
    call system(printf('cmd.exe /c start rundll32 %s %s',
          \ 'url.dll,FileProtocolHandler',
          \ filename->escape('#%')))
  else
    " Give up.
    throw 'Not supported.'
  endif
endfunction

function! ddu#kind#file#cwd_input(cwd, prompt, text, completion) abort
  redraw

  let prev = getcwd()
  try
    if a:cwd !=# ''
      call chdir(a:cwd)
    endif
    return input(a:prompt, a:text, a:completion)
  catch /^Vim:Interrupt/
  finally
    call chdir(prev)
  endtry

  return ''
endfunction

function! s:check_wsl() abort
  if has('nvim')
    return has('wsl')
  endif
  if has('unix') && 'uname'->executable()
    return 'uname -r'->system()->match("\\cMicrosoft") >= 0
  endif
  return v:false
endfunction

function! ddu#kind#file#confirm(msg, choices, default) abort
  try
    return confirm(a:msg, a:choices, a:default)
  catch
    " ignore the errors
  endtry

  return a:default
endfunction

function! ddu#kind#file#getchar(default) abort
  try
    return getchar()->nr2char()
  catch
    " ignore the errors
  endtry

  return a:default
endfunction

function! ddu#kind#file#check_overwrite_method(msg, default) abort
  let method = ''
  while method !~? '^[fnrtu]$'
    " Retry.
    echo a:msg
    let method = ddu#kind#file#getchar(a:default)
  endwhile

  redraw

  return method
endfunction

function! ddu#kind#file#print(string, ...) abort
  let name = a:0 ? a:1 : 'ddu-kind-file'
  echomsg printf('[%s] %s', name,
        \ a:string->type() ==# v:t_string ? a:string : a:string->string())
endfunction

function! ddu#kind#file#buffer_rename(bufnr, new_filename) abort
  if a:bufnr < 0 || !(a:bufnr->bufloaded())
    return
  endif

  let hidden = &hidden

  set hidden
  let bufnr_save = '%'->bufnr()
  noautocmd silent! execute 'buffer' a:bufnr
  silent! execute (&l:buftype ==# '' ? 'saveas!' : 'file')
        \ a:new_filename->fnameescape()
  if &l:buftype ==# ''
    " Remove old buffer.
    silent! bdelete! #
  endif

  noautocmd silent execute 'buffer' bufnr_save
  let &hidden = hidden
endfunction

function! ddu#kind#file#buffer_delete(bufnr) abort
  if a:bufnr < 0
    return
  endif

  let winid = a:bufnr->win_findbuf()->get(0, -1)
  if winid > 0
    let winid_save = win_getid()
    call win_gotoid(winid)

    noautocmd silent enew
    execute 'silent! bdelete!' a:bufnr

    call win_gotoid(winid_save)
  else
    execute 'silent! bdelete!' a:bufnr
  endif
endfunction

function! ddu#kind#file#bufnr(filename) abort
  " NOTE: bufnr() may be wrong.  It returns submatched buffer number.
  return a:filename->bufexists() ? a:filename->bufnr() : -1
endfunction
