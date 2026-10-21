import { mount } from 'svelte';
import App from './App.svelte';
import { initTheme } from './lib/stores/theme';
import './styles/tokens.css';
import './styles/app.css';
import 'katex/dist/katex.min.css';
import './styles/markdown.css';

initTheme();

const target = document.getElementById('app');
if (!target) throw new Error('#app fehlt');

export default mount(App, { target });
