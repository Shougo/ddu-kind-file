"=============================================================================
" FILE: exrename.vim
" AUTHOR: Shougo Matsushita <Shougo.Matsu at gmail.com>
" EDITOR: Alisue <lambdalisue at hashnote.net>
" License: MIT license
"=============================================================================

let s:PREFIX = has('win32') ? '[exrename]' : '*exrename*'

function! ddu#kind#file#exrename#create_buffer(items, ...) abort
  let options = extend(#{
        \   cwd: getcwd(),
        \   bufnr: '%'->bufnr(),
        \   buffer_name: '',
        \   post_rename_callback: v:null,
        \ }, a:000->get(0, {}))
  if options.cwd !~# '/$'
    " current working directory MUST end with a trailing slash
    let options.cwd ..= '/'
  endif
  let options.buffer_name = s:PREFIX
  if options.buffer_name !=# ''
    let options.buffer_name ..= ' - ' .. options.buffer_name
  endif

  let winid = win_getid()

  let bufnr = options.buffer_name->bufadd()
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

  nnoremap <buffer><silent> q <Cmd>call <SID>exit('%'->bufnr())<CR>
  augroup ddu-exrename
    autocmd! * <buffer>
    autocmd BufHidden <buffer> call s:exit('<abuf>'->expand())
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
      let item.action__path = b:exrename.cwd .. item.action__path
    endif

    " Make sure that the 'action__path' exists
    if !(item.action__path->filewritable())
          \ && !(item.action__path->isdirectory())
      redraw
      call ddu#util#print_error(
            \ item.action__path .. ' does not exist. Skip.')
      continue
    endif

    " Make sure that the 'action__path' is unique
    if unique_filenames->has_key(item.action__path)
      redraw
      call ddu#util#print_error(
            \ item.action__path .. ' is duplicated. Skip.')
      continue
    endif

    " Create filename
    let filename = item.action__path
    if filename->stridx(b:exrename.cwd) == 0
      let filename = filename[b:exrename.cwd->len() :]
    endif
    " directory should end with a trailing slash (to distinguish easily)
    if item.action__path->isdirectory()
      let filename ..= '/'
    endif

    let pattern = s:escape_pattern(filename)->escape('/')
    execute 'syntax match dduExrenameOriginal'
          \ '/' .. printf('^\%%%dl%s$', cnt, pattern) .. '/'

    " Register
    let unique_filenames[item.action__path] = 1
    call add(b:exrename.items, item)
    call add(b:exrename.filenames, filename)

    let cnt += 1
  endfor

  let b:exrename.unique_filenames = unique_filenames
  let b:exrename.prev_winid = winid

  " write filenames
  let [undolevels, &l:undolevels] = [&l:undolevels, -1]
  try
    call setline(1, b:exrename.filenames)
  finally
    let &l:undolevels = undolevels
  endtry
  setlocal nomodified

  " Move to the UI window
  call win_gotoid(winid)
endfunction

function! s:escape_pattern(str) abort
  return a:str->escape('~"\.^$[]*')
endfunction

function! s:is_absolute(path) abort
  return a:path =~# '^\%(\a\a\+:\)\|^\%(\a:\|/\)'
endfunction

function! s:do_rename() abort
  if '$'->line() != b:exrename.filenames->len()
    call ddu#util#print_error('Invalid rename buffer!')
    return
  endif

  " Rename files.
  let linenr = 1
  let max = '$'->line()
  while linenr <= max
    let filename = b:exrename.filenames[linenr - 1]

    redraw
    echo printf('(%' .. len(max) .. 'd/%d): %s -> %s',
          \ linenr, max, filename, linenr->getline())

    if filename ==# linenr->getline()
      let linenr += 1
      continue
    endif

    let old_file = b:exrename.items[linenr - 1].action__path
    let new_file = linenr->getline()->expand()
    if !s:is_absolute(new_file)
      " Convert to absolute path
      let new_file = b:exrename.cwd . new_file
    endif

    if new_file->filereadable() || new_file->isdirectory()
      " new_file is already exists.
      redraw
      call ddu#util#print_error(
            \ new_file .. ' is already exists. Skip.')

      let linenr += 1
      continue
    endif

    " Create the parent directory.
    call mkdir(new_file->fnamemodify(':h'), 'p')

    if rename(old_file, new_file)
      " Rename error
      redraw
      call ddu#util#print_error(
            \ new_file .. ' is rename error. Skip.')

      let linenr += 1
      continue
    endif

    call ddu#kind#file#buffer_rename(bufnr(old_file), new_file)

    " update b:exrename
    let b:exrename.filenames[linenr - 1] = linenr->getline()
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
  if !(a:bufnr->bufexists())
    return
  endif

  let exrename = a:bufnr->getbufvar('exrename', {})

  " Switch buffer.
  if '$'->winnr() != 1
    close
  else
    call s:custom_alternate_buffer()
  endif
  silent execute 'bdelete!' a:bufnr

  call win_gotoid(exrename.prev_winid)
  call ddu#redraw(exrename.name, #{ method: 'refreshItems' })
endfunction

function! s:check_lines() abort
  if !('b:exrename'->exists())
    return
  endif

  if '$'->line() != b:exrename.filenames->len()
    call ddu#util#print_error('Invalid rename buffer!')
    return
  endif
endfunction

function! s:custom_alternate_buffer() abort
  if '%'->bufnr() != '#'->bufnr() && '#'->bufnr()->buflisted()
    buffer #
  endif

  let cnt = 0
  let pos = 1
  let current = 0
  while pos <= '$'->bufnr()
    if pos->buflisted()
      if pos == '%'->bufnr()
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
