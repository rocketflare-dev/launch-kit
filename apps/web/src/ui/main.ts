/** The placeholder UI: who is signed in, and the example notes. Replace it with your own. */
import { OIDC_SIGNED_OUT_PATH } from '../auth/paths'

interface Me {
  id: string
  email: string | null
  name: string | null
  admin: boolean
}
interface Note {
  id: string
  body: string
  authorName: string | null
  createdAt: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status })
  }
  return res.json() as Promise<T>
}

function showError(err: unknown) {
  $('error').textContent = err instanceof Error ? err.message : String(err)
}

async function renderSignedOut() {
  $('signed-out').hidden = false
  const methods = await api<{ oidc: boolean; dev: boolean }>('/api/auth/methods')
  const p = $('methods')
  p.replaceChildren()
  if (methods.oidc) {
    const a = Object.assign(document.createElement('a'), {
      href: '/auth/login',
      className: 'button',
      textContent: 'Sign in with single sign-on',
    })
    p.append(a)
  }
  if (methods.dev) {
    const a = Object.assign(document.createElement('a'), {
      href: '/auth/dev-login?email=dev@example.com',
      className: 'button',
      textContent: 'Development sign-in (dev@example.com)',
    })
    p.append(' ', a)
  }
  if (!methods.oidc && !methods.dev) p.textContent = 'Sign-in is not configured.'
}

async function renderNotes() {
  const { notes } = await api<{ notes: Note[] }>('/api/notes')
  const list = $('notes')
  list.replaceChildren(
    ...notes.map(note => {
      const li = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = `${note.body} (${note.authorName ?? 'someone'})`
      const del = Object.assign(document.createElement('button'), {
        className: 'link',
        textContent: 'Delete',
        onclick: () =>
          api(`/api/notes/${note.id}`, { method: 'DELETE' }).then(renderNotes).catch(showError),
      })
      li.append(text, del)
      return li
    })
  )
}

async function renderSignedIn(me: Me) {
  $('signed-in').hidden = false
  const user = $('user')
  user.textContent = `${me.name ?? me.email ?? me.id}${me.admin ? ' (admin)' : ''}`
  const out = Object.assign(document.createElement('button'), {
    className: 'link',
    textContent: 'Sign out',
    onclick: () =>
      api('/auth/logout', { method: 'POST' }).then(() => location.assign(OIDC_SIGNED_OUT_PATH)),
  })
  user.append(out)
  $<HTMLFormElement>('note-form').onsubmit = event => {
    event.preventDefault()
    const input = $<HTMLInputElement>('note-body')
    api('/api/notes', { method: 'POST', body: JSON.stringify({ body: input.value }) })
      .then(() => {
        input.value = ''
        return renderNotes()
      })
      .catch(showError)
  }
  await renderNotes()
}

async function main() {
  try {
    const me = await api<Me>('/api/me')
    await renderSignedIn(me)
  } catch (err) {
    if ((err as { status?: number }).status === 401) await renderSignedOut()
    else showError(err)
  }
}

main().catch(showError)
