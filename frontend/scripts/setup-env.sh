#!/bin/bash

# Script para configurar archivos .env

echo "🔧 Configuración de Variables de Entorno - Frontend"
echo ""

# Verificar si ya existen los archivos
if [ -f ".env.development" ]; then
    echo "⚠️  .env.development ya existe"
    read -p "¿Sobrescribir? (y/n): " overwrite
    if [ "$overwrite" != "y" ]; then
        echo "❌ Cancelado"
        exit 0
    fi
fi

if [ -f ".env.production" ]; then
    echo "⚠️  .env.production ya existe"
    read -p "¿Sobrescribir? (y/n): " overwrite
    if [ "$overwrite" != "y" ]; then
        echo "❌ Cancelado"
        exit 0
    fi
fi

# Copiar archivos de ejemplo
if [ -f "env.development.txt" ]; then
    cp env.development.txt .env.development
    echo "✅ .env.development creado"
else
    echo "❌ No se encontró env.development.txt"
fi

if [ -f "env.production.txt" ]; then
    cp env.production.txt .env.production
    echo "✅ .env.production creado"
else
    echo "❌ No se encontró env.production.txt"
fi

echo ""
echo "📝 Por favor, edita los archivos .env.development y .env.production con tus valores"
echo ""







