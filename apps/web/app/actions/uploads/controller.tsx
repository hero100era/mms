import { createController } from 'remix/router'
import { routes } from '../../routes.ts'
import {
  handleDocumentDownload,
  handleFinalize,
  handlePrepare,
  handlePromote,
  handleQuarantine,
  handleScan,
} from './handlers.ts'

export { readJsonWithLimit } from './validation.ts'

export default createController(routes.uploads, {
  actions: {
    prepare: handlePrepare,
    quarantine: handleQuarantine,
    finalize: handleFinalize,
    promote: handlePromote,
    scan: handleScan,
    documentDownload: handleDocumentDownload,
  },
})
