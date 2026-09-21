import { ComponentSettings, Manager } from '@managed-components/types'

export default async function (manager: Manager, _settings: ComponentSettings) {
  manager.addEventListener('pageview', event => {
    void event
  })
}
