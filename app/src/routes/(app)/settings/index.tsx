import { createFileRoute } from '@tanstack/react-router'
import { listSettingsFn } from './-lib/list-settings.fn'
import { ConnectedPagesList } from './-components/ConnectedPagesList'
import { m } from '~/paraglide/messages'

export const Route = createFileRoute('/(app)/settings/')({
  loader: () => listSettingsFn(),
  component: SettingsPage,
})

function SettingsPage() {
  const { connectedPages } = Route.useLoaderData()

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '32px 40px',
        maxWidth: 720,
      }}
    >
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.02em' }}>
          {m.settings_title()}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--color-ink-2)', margin: 0 }}>
          {m.settings_subtitle()}
        </p>
      </div>

      <section>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--color-ink-3)',
            margin: '0 0 12px',
          }}
        >
          {m.settings_section_pages()}
        </h2>
        <ConnectedPagesList connectedPages={connectedPages} />
      </section>
    </div>
  )
}
