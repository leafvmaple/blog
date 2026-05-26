import { lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import NotFound from './pages/NotFound'

const Home = lazy(() => import('./pages/Home'))
const About = lazy(() => import('./pages/About'))
const PostDetail = lazy(() => import('./pages/PostDetail'))
const Archive = lazy(() => import('./pages/Archive'))
const Label = lazy(() => import('./pages/Label'))
const Series = lazy(() => import('./pages/Series'))

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<About />} />
        <Route path="/blog" element={<Home />} />
        <Route path="/post/:number" element={<PostDetail />} />
        <Route path="/archive" element={<Archive />} />
        <Route path="/label/:name" element={<Label />} />
        <Route path="/series/:slug" element={<Series />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
