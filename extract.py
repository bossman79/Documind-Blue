import json
import re

log_path = r'C:\Users\vgiordano\.gemini\antigravity\brain\94be933a-43ee-4aae-9a30-ac0c3738fcdd\.system_generated\logs\overview.txt'

found_content = None

with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
    for line in f:
        try:
            data = json.loads(line)
            content = data.get('content', '')
            if 'Attribute VB_Name' in content and 'Option Explicit' in content:
                found_content = content
        except Exception as e:
            pass

if found_content:
    print('Found content!')
    # Split by newline
    lines = found_content.split('\n')
    
    clean_lines = []
    in_file = False
    
    for l in lines:
        if '1: Attribute VB_Name' in l or '1: Option Explicit' in l or '1: ' in l and 'Attribute' in l:
            in_file = True
            
        if in_file:
            parts = l.split(': ', 1)
            if len(parts) == 2 and parts[0].strip().isdigit():
                clean_lines.append(parts[1] + '\n')
                
    if len(clean_lines) > 500:
        with open('DocumentRelationshipAnalyzer.bas', 'w', encoding='utf-8') as out:
            out.writelines(clean_lines)
        print(f'Restored {len(clean_lines)} lines successfully!')
    else:
        print(f'Only found {len(clean_lines)} lines, aborting.')
else:
    print('No content found in log.')
