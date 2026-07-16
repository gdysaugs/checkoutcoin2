const CROWN_API_ORIGIN = 'https://crown-ai.uk'

const copyRequestHeaders = (request: Request) => {
  const headers = new Headers()
  const authorization = request.headers.get('Authorization')
  const contentType = request.headers.get('Content-Type')
  if (authorization) headers.set('Authorization', authorization)
  if (contentType) headers.set('Content-Type', contentType)
  headers.set('Accept', 'application/json')
  return headers
}

const copyResponseHeaders = (response: Response) => {
  const headers = new Headers()
  headers.set('Content-Type', response.headers.get('Content-Type') || 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

export const proxyCrownApi = async (request: Request, pathname: string) => {
  const requestUrl = new URL(request.url)
  const upstreamUrl = new URL(pathname, CROWN_API_ORIGIN)
  upstreamUrl.search = requestUrl.search

  const init: RequestInit = {
    method: request.method,
    headers: copyRequestHeaders(request),
    redirect: 'manual',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  try {
    const upstream = await fetch(upstreamUrl.toString(), init)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream),
    })
  } catch {
    return new Response(JSON.stringify({ error: '購入サービスへの接続に失敗しました。' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  }
}

export const proxyOptions = () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
