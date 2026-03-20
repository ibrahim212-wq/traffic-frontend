# Smart City Traffic Dashboard - Frontend

A modern React traffic simulation dashboard built with Vite, Deck.gl, and MapLibre GL.

## Development

### Prerequisites
- Node.js 18+
- npm or yarn

### Setup
```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The development server runs on `http://localhost:5173` and proxies WebSocket connections to `ws://localhost:8000`.

## Environment Variables

Create a `.env` file in the root directory:

```env
VITE_WS_URL=ws://localhost:8000
```

For production deployment, create `.env.production`:

```env
VITE_WS_URL=ws://YOUR_BACKEND_IP:8000
```

## Build for Production

```bash
# Build the application
npm run build

# Preview the build locally
npm run preview
```

The build output is placed in the `dist/` directory.

## Deployment on Vercel

### Automatic Deployment with GitHub

1. Push your code to a GitHub repository
2. Connect your repository to Vercel
3. Vercel will automatically detect the Vite project and deploy it

### Manual Deployment

1. Install Vercel CLI:
```bash
npm i -g vercel
```

2. Deploy:
```bash
vercel --prod
```

### Environment Variables on Vercel

Set the `VITE_WS_URL` environment variable in your Vercel dashboard:
- Go to Project Settings → Environment Variables
- Add: `VITE_WS_URL` = `ws://YOUR_BACKEND_IP:8000`

## Configuration

### Vite Configuration (`vite.config.js`)

- **Base path**: Set to `/` for root deployment
- **Build optimization**: 
  - Manual chunks for vendor libraries (React, Deck.gl, MapLibre, Recharts)
  - Terser minification with console.log removal
  - Source maps enabled for debugging
- **Development proxy**: WebSocket proxy to backend

### Vercel Configuration (`vercel.json`)

SPA routing configuration ensures all routes are served by `index.html`:
```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

## Architecture

- **React 18** with hooks and functional components
- **Zustand** for state management
- **Deck.gl** for map visualization layers
- **MapLibre GL** for base map tiles
- **Recharts** for confidence charts
- **WebSocket** for real-time simulation data

## Key Features

- Real-time vehicle tracking with smooth interpolation
- Traffic light state visualization
- AI decision engine confidence display
- Traffic density heatmap
- Responsive control-room style interface

## CORS Configuration

Ensure your backend allows WebSocket connections from your Vercel domain:

```python
# In your FastAPI backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://your-app.vercel.app"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

## Troubleshooting

### WebSocket Connection Issues

1. Check that `VITE_WS_URL` is correctly set in your environment
2. Verify backend is running and accessible
3. Ensure CORS is properly configured on the backend
4. Check browser console for WebSocket errors

### Build Issues

1. Clear node_modules and reinstall: `rm -rf node_modules package-lock.json && npm install`
2. Check that all environment variables are properly prefixed with `VITE_`
3. Verify no hardcoded URLs remain in the codebase

## License

MIT
