import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(public)/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main>
      <h1>fumireply</h1>
      <p>Walking Skeleton — Hello World</p>
    </main>
  )
}
