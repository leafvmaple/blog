import { useEffect } from 'react'

interface MetaOptions {
  /** Document title. Falls back to the value of `siteTitle` if omitted. */
  title?: string
  /** Plain-text description for <meta name=description> + og:description. */
  description?: string
  /** Optional og:image override. */
  image?: string
  /** Optional canonical URL override. Defaults to window.location.href. */
  canonicalUrl?: string
}

const SITE_TITLE = 'Zohar Lee 事件簿'

function upsertMeta(key: string, attr: 'name' | 'property', content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.content = content
}

function upsertLink(rel: string, href: string) {
  let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement('link')
    el.rel = rel
    document.head.appendChild(el)
  }
  el.href = href
}

// Per-page meta tag manager. SPA navigation otherwise leaves the index.html's
// site-level title / og tags in place, which breaks per-post social shares and
// SEO snippets. The hook stamps the active page's title + description into the
// document head; the next page that mounts will overwrite them.
export function useDocumentMeta({ title, description, image, canonicalUrl }: MetaOptions) {
  useEffect(() => {
    const docTitle = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE
    document.title = docTitle
    upsertMeta('og:title', 'property', docTitle)
    upsertMeta('twitter:title', 'name', docTitle)

    if (description !== undefined) {
      upsertMeta('description', 'name', description)
      upsertMeta('og:description', 'property', description)
      upsertMeta('twitter:description', 'name', description)
    }

    if (image) {
      upsertMeta('og:image', 'property', image)
      upsertMeta('twitter:image', 'name', image)
    }

    const url = canonicalUrl ?? window.location.href
    upsertMeta('og:url', 'property', url)
    upsertLink('canonical', url)
  }, [title, description, image, canonicalUrl])
}
