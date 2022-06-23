"=============================================================================
" FILE: exrename.vim
" AUTHOR: Shougo Matsushita <Shougo.Matsu at gmail.com>
" EDITOR: Alisue <lambdalisue at hashnote.net>
" License: MIT license
"=============================================================================

let s:PREFIX = has('win32') ? '[exrename]' : '*exrename*'

function! ddu#kind#file#exrename#create_buffer(items, ...) abort
  let options = extend({
        \ 'cwd': getcwd(),
        \ 'bufnr': bufnr('%'),
        \ 'buffer_name': '',
        \ 'post_rename_callback': v:null,
        \ }, get(a:000, 0, {}))
  if options.cwd !~# '/$'
    " current working directory MUST end with a trailing slash
    let options.cwd .= '/'
  endif
  let options.buffer_name = s:PREFIX
  if options.buffer_name !=# ''
    let options.buffer_name .= ' - ' . options.buffer_name
  endif

  let winid = win_getid()

  let bufnr = bufadd(options.buffer_name)
  call bufload(bufnr)
  execute 'vertical sbuffer' bufnr

  setlocal buftype=acwrite
  setlocal noswapfile
  setfiletype ddu_exrename

  syntax match dduExrenameModified '^.*$'

  highlight def link dduExrenameModified Todo
  highlight def link dduExrenameOriginal Normal

  let b:exrename = options

  call chdir(b:exrename.cwd)

  nnoremap <buffer><silent> q <Cmd>call <SID>exit(bufnr('%'))<CR>
  augroup ddu-exrename
    autocmd! * <buffer>
    autocmd BufHidden <buffer> call s:exit(expand('<abuf>'))
    autocmd BufWriteCmd <buffer> call s:do_rename()
    autocmd CursorMoved,CursorMovedI <buffer> call s:check_lines()
  augroup END

  " Clean up the screen.
  silent % delete _
  silent! syntax clear dduExrenameOriginal

  " Validate items and register
  let unique_filenames = {}
  let b:exrename.items = []
  let b:exrename.filenames = []
  let cnt = 1
  for item in a:items
    " Make sure that the 'action__path' is absolute path
    if !s:is_absolute(item.action__path)
      let item.action__path = b:exrename.cwd . item.action__path
    endif
    " Make sure that the 'action__path' exists
    if !filewritable(item.action__path)
          \ && !isdirectory(item.action__path)
      redraw
      call ddu#util#print_error(
            \ item.action__path . ' does not exist. Skip.')
      continue
    endif
    " Make sure that the 'action__path' is unique
    if has_key(unique_filenames, item.action__path)
      redraw
      call ddu#util#print_error(
            \ item.action__path . ' is duplicated. Skip.')
      continue
    endif
    " Create filename
    let filename = item.action__path
    if stridx(filename, b:exrename.cwd) == 0
      let filename = filename[len(b:exrename.cwd) :]
    endif
    " directory should end with a trailing slash (to distinguish easily)
    if isdirectory(item.action__path)
      let filename .= '/'
    endif

    execute 'syntax match dduExrenameOriginal'
          \ '/'.printf('^\%%%dl%s$', cnt,
          \ escape(s:escape_pattern(filename), '/')).'/'
    " Register
    let unique_filenames[item.action__path] = 1
    call add(b:exrename.items, item)
    call add(b:exrename.filenames, filename)
    let cnt += 1
  endfor

  let b:exrename.unique_filenames = unique_filenames
  let b:exrename.prev_winid = winid

  " write filenames
  let [undolevels, &undolevels] = [&undolevels, -1]
  try
    call setline(1, b:exrename.filenames)
  finally
    let &undolevels = undolevels
  endtry
  setlocal nomodified

  " Move to the UI window
  call win_gotoid(winid)
endfunction

function! s:escape_pattern(str) abort
  return escape(a:str, '~"\.^$[]*')
endfunction

function! s:is_absolute(path) abort
  return a:path =~# '^\%(\a\a\+:\)\|^\%(\a:\|/\)'
endfunction

function! s:do_rename() abort
  if line('$') != len(b:exrename.filenames)
    call ddu#util#print_error('Invalid rename buffer!')
    return
  endif

  " Rename files.
  let linenr = 1
  let max = line('$')
  while linenr <= max
    let filename = b:exrename.filenames[linenr - 1]

    redraw
    echo printf('(%'.len(max).'d/%d): %s -> %s',
          \ linenr, max, filename, getline(linenr))

    if filename ==# getline(linenr)
      let linenr += 1
      continue
    endif

    let old_file = b:exrename.items[linenr - 1].action__path
    let new_file = expand(getline(linenr))
    if !s:is_absolute(new_file)
      " Convert to absolute path
      let new_file = b:exrename.cwd . new_file
    endif

    if filereadable(new_file) || isdirectory(new_file)
      " new_file is already exists.
      redraw
      call ddu#util#print_error(
            \ new_file . ' is already exists. Skip.')

      let linenr += 1
      continue
    endif

    " Create the parent directory.
    call mkdir(fnamemodify(new_file, ':h'), 'p')

    if rename(old_file, new_file)
      " Rename error
      redraw
      call ddu#util#print_error(
            \ new_file . ' is rename error. Skip.')

      let linenr += 1
      continue
    endif

    call ddu#kind#file#buffer_rename(bufnr(old_file), new_file)

    " update b:exrename
    let b:exrename.filenames[linenr - 1] = getline(linenr)
    let b:exrename.items[linenr - 1].action__path = new_file

    let linenr += 1
  endwhile

  redraw
  echo 'Rename done!'

  setlocal nomodified

  if b:exrename.post_rename_callback != v:null
    call b:exrename.post_rename_callback(b:exrename)
  endif
endfunction

function! s:exit(bufnr) abort
  if !bufexists(a:bufnr)
    return
  endif

  let exrename = getbufvar(a:bufnr, 'exrename', {})

  " Switch buffer.
  if winnr('$') != 1
    close
  else
    call s:custom_alternate_buffer()
  endif
  silent execute 'bdelete!' a:bufnr

  call win_gotoid(exrename.prev_winid)
  call ddu#redraw(exrename.name, { 'refreshItems': v:true })
endfunction

function! s:check_lines() abort
  if !exists('b:exrename')
    return
  endif

  if line('$') != len(b:exrename.filenames)
    call ddu#util#print_error('Invalid rename buffer!')
    return
  endif
endfunction

function! s:custom_alternate_buffer() abort
  if bufnr('%') != bufnr('#') && buflisted(bufnr('#'))
    buffer #
  endif

  let cnt = 0
  let pos = 1
  let current = 0
  while pos <= bufnr('$')
    if buflisted(pos)
      if pos == bufnr('%')
        let current = cnt
      endif

      let cnt += 1
    endif

    let pos += 1
  endwhile

  if current > cnt / 2
    bprevious
  else
    bnext
  endif
endfunction
