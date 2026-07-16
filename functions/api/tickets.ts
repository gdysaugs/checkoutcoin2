import { proxyCrownApi, proxyOptions } from '../_shared/crownProxy'

export const onRequestOptions: PagesFunction = async () => proxyOptions()
export const onRequestGet: PagesFunction = async ({ request }) => proxyCrownApi(request, '/api/tickets')
