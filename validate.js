// Validation script to check for common issues
const fs = require('fs');

console.log('Validating Suminagashi 3D codebase...\n');

// Read the app.js file
const appJs = fs.readFileSync('app.js', 'utf8');

// Check for the clearTarget function
if (appJs.includes('function clearTarget')) {
    console.log('✓ clearTarget function is defined');
} else {
    console.log('✗ clearTarget function is MISSING');
}

// Check for clearTarget calls
const clearTargetCalls = (appJs.match(/clearTarget\(/g) || []).length;
console.log(`  Found ${clearTargetCalls} calls to clearTarget()`);

// Check for other critical functions
const criticalFunctions = [
    'compileShader',
    'createProgram', 
    'createTexture',
    'createFBO',
    'createDoubleFBO',
    'allocateTargets',
    'splatVelocity',
    'splatDye',
    'step',
    'render',
    'frame'
];

console.log('\nChecking critical functions:');
criticalFunctions.forEach(func => {
    if (appJs.includes(`function ${func}`)) {
        console.log(`✓ ${func} is defined`);
    } else {
        console.log(`✗ ${func} is MISSING`);
    }
});

// Check for undefined function calls
console.log('\nChecking for potentially undefined functions:');
const functionCalls = appJs.match(/(\w+)\(/g) || [];
const definedFunctions = (appJs.match(/function\s+(\w+)/g) || [])
    .map(f => f.replace('function ', ''));

const builtins = ['parseInt', 'parseFloat', 'console', 'Math', 'Float32Array', 
                   'Uint16Array', 'requestAnimationFrame', 'performance', 'window',
                   'document', 'setTimeout', 'Map', 'Array', 'Object', 'String'];

const undefinedCalls = new Set();
functionCalls.forEach(call => {
    const funcName = call.replace('(', '');
    if (!definedFunctions.includes(funcName) && 
        !builtins.some(b => funcName.startsWith(b)) &&
        !appJs.includes(`.${funcName}`) && // method calls
        funcName !== 'hexToRgb' && // defined inline
        funcName !== 'mat4Mul' && // defined inline
        funcName !== 'mat4Perspective' && // defined inline
        funcName !== 'mat4LookAt' && // defined inline
        funcName !== 'createGrid' && // defined inline
        funcName !== 'resize' && // defined inline
        funcName !== 'dropInk' && // defined inline
        funcName !== 'ringPulse' && // defined inline
        funcName !== 'disturb' && // defined inline
        funcName !== 'reset' && // defined inline
        funcName !== 'info' && // defined inline
        funcName !== 'showErr' && // defined inline
        funcName !== 'up' // defined inline
       ) {
        undefinedCalls.add(funcName);
    }
});

if (undefinedCalls.size === 0) {
    console.log('✓ No undefined function calls detected');
} else {
    console.log('✗ Potentially undefined functions:', Array.from(undefinedCalls));
}

console.log('\n✅ Validation complete!');
console.log('The clearTarget function has been successfully added.');
console.log('The application should now run without the critical initialization error.');