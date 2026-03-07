#!/bin/bash

# Smart City Traffic Dashboard - Deployment Script
# This script helps prepare and deploy the frontend to Vercel

set -e

echo "🚀 Smart City Traffic Dashboard - Deployment Preparation"
echo "=================================================="

# Check if we're in the correct directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the frontend root directory."
    exit 1
fi

# Check if .env.production exists
if [ ! -f ".env.production" ]; then
    echo "⚠️  Warning: .env.production not found."
    echo "   Creating template .env.production file..."
    echo "VITE_WS_URL=ws://YOUR_BACKEND_IP:8000" > .env.production
    echo "   📝 Please edit .env.production and replace YOUR_BACKEND_IP with your actual backend IP"
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Run build
echo "🔨 Building for production..."
npm run build

# Check if build was successful
if [ ! -d "dist" ]; then
    echo "❌ Error: Build failed - dist directory not found"
    exit 1
fi

echo "✅ Build completed successfully!"
echo ""
echo "📋 Next steps for Vercel deployment:"
echo "   1. Push your code to GitHub"
echo "   2. Connect your repository to Vercel"
echo "   3. Set VITE_WS_URL environment variable in Vercel dashboard"
echo "   4. Deploy!"
echo ""
echo "🔧 To test locally:"
echo "   npm run preview"
echo ""
echo "🌐 To deploy manually:"
echo "   npx vercel --prod"
