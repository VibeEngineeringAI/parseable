import type { StorybookConfig } from '@storybook/react-vite';
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: '@storybook/react-vite',
  addons: ['@storybook/addon-docs'],
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.define = {
      ...config.define,
      'import.meta.env.VITE_ENABLE_DEMO': JSON.stringify('true'),
    };
    return config;
  },
};
export default config;
