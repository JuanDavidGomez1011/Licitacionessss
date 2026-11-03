import React from 'react'
import { createRoot } from 'react-dom/client'
import Oportunidades from './Oportunidades'
import './styles.css'

const raiz = document.getElementById('root')
if (!raiz) throw new Error('index.html no tiene el #root donde montar el panel')

createRoot(raiz).render(
  <React.StrictMode>
    <Oportunidades />
  </React.StrictMode>,
)
