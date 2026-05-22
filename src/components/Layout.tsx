import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import Header from './Header'
import Background from './Background'
import { useT } from '../i18n'
import './Layout.css'

function RouteFallback() {
  const t = useT()
  return <div className="route-fallback">{t.loading}</div>
}

export default function Layout() {
  return (
    <>
      <Background />
      <Header />
      <main className="main-content">
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  )
}
