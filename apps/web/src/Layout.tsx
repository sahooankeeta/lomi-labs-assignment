import { Box } from '@mantine/core';
import { Outlet } from 'react-router';
import { Sidebar } from './components/Sidebar';
import { palette } from './theme';
import './layout.css';

/**
 * App chrome: a fixed black (ink) sidebar (upload form, API health) on every page, and one large
 * rounded panel holding the routed page, offset to the right of the sidebar.
 */
export function Layout() {
  return (
    <Box p={12} mih="100vh">
      <Sidebar />
      <Box
        className="app-panel"
        p={12}
        style={{
          background: palette.panel,
          border: `1px solid ${palette.line}`,
          borderRadius: 24,
          minHeight: 'calc(100vh - 24px)',
        }}
      >
        {/* minWidth 0 lets the detail page's PDF column shrink instead of overflowing. */}
        <Box component="main" px="xl" py="lg" style={{ minWidth: 0 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
