const routes = [
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue')
  },

  // Always leave this as last one,
  // but you can also remove it
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue')
  },
  {
    path: '/offline',
    component: () => import('pages/OnWsOffline.vue')
  }
]

export default routes
