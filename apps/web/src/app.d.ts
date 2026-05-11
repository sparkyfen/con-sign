// See https://svelte.dev/docs/kit/types#app

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    interface Platform {
      env?: {
        // Bindings inherited from the Worker would go here if the Pages
        // build ever needed direct binding access. Today the Pages app
        // only talks to the Worker via fetch on /api/*.
      };
    }
  }
}

export {};
