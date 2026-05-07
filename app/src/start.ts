import { createStart } from '@tanstack/react-start'
import { localeMiddleware } from '~/lib/i18n/locale-middleware'

export const startInstance = createStart(() => ({
  requestMiddleware: [localeMiddleware],
}))
