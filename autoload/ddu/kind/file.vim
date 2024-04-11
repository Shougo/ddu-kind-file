let s:is_windows = has('win32') || has('win64')

function! ddu#kind#file#open(filename, method) abort
  let filename = a:filename->fnamemodify(':p')

  const method = a:method ==# '' ? s:detect_method() : a:method

  if method ==# 'nvim-open'
    " Use vim.ui.open instead
    call v:lua.vim.ui.open(filename)
    return
  elseif method ==# 'windows-rundll32'
    " NOTE:
    "   # and % required to be escaped (:help cmdline-special)
    silent execute printf(
          \    '!start rundll32 url.dll,FileProtocolHandler %s',
          \    filename->escape('#%'),
          \ )
    return
  elseif method ==# 'kioclient'
    let command = 'kioclient exec'
  elseif method->executable()
    let command = method
  else
    if is_wsl && 'cmd.exe'->executable()
      " WSL and not installed any open commands

      " Open the same way as Windows.
      " I don't know why, but the method using execute requires redraw <C-l>
      " after execution in vim.
      call system(printf('cmd.exe /c start rundll32 %s %s',
            \   'url.dll,FileProtocolHandler',
            \   filename->escape('#%')),
            \ )
      return
    endif

    " Give up.
    throw 'Not supported.'
  endif

  call system(printf('%s %s &', command, filename->shellescape()))
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

function! s:check_wsl() abort
  if has('nvim')
    return has('wsl')
  endif
  if has('unix') && 'uname'->executable()
    return 'uname -r'->system()->match("\\cMicrosoft") >= 0
  endif
  return v:false
endfunction

function! s:detect_method() abort
  if has('nvim-0.10')
    " Use vim.ui.open instead
    return 'nvim-open'
  endif

  let is_cygwin = has('win32unix')
  let is_mac = !s:is_windows && !is_cygwin
        \ && (has('mac') || has('macunix') || has('gui_macvim') ||
        \   (!'/proc'->isdirectory() && 'sw_vers'->executable()))
  let is_wsl = s:check_wsl()

  if s:is_windows
    return 'windows-rundll32'
  endif

  if is_cygwin
    " Cygwin.
    return 'cygstart'
  elseif is_mac && executable('open')
    " Mac OS.
    return 'open'
  elseif is_wsl && executable('wslview')
    return 'wslview'
  elseif 'xdg-open'->executable()
    return 'xdg-open'
  elseif '$KDE_FULL_SESSION'->exists() && $KDE_FULL_SESSION ==# 'true'
    return 'kioclient'
  elseif exists('$GNOME_DESKTOP_SESSION_ID')
    return 'gnome-open'
  elseif 'exo-open'->executable()
    return 'exo-open'
  endif

  return ''
endfunction
