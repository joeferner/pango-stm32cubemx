import {ProjectOptions, Task, TaskOptions} from "pango";
import * as fs from "fs-extra";
import * as path from "path";
import * as ejs from "ejs";
import * as glob from "glob-promise";
import {COMPONENT_NAME} from "./STM32CubeMXComponent";
import {STM32CubeMXComponentOptions} from "./STM32CubeMXComponentOptions";
import {MakefileParser} from "./MakefileParser";

export class STM32CubeMXGenTask extends Task {
    getPostRequisites(projectOptions: ProjectOptions): string[] {
        return ['compile'];
    }

    async run(taskOptions: TaskOptions): Promise<void> {
        const genDir: string = path.join(taskOptions.projectOptions.buildDir, 'stm32cubemx', 'gen');
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const armGccComponent = taskOptions.projectOptions.components['arm-gcc'] || {};
        const iocFile = path.join(genDir, 'stm32cubemx.ioc');
        const touchFile = path.join(genDir, 'stm32cubemxgen');
        await fs.mkdirs(genDir);
        const inputIocFile = await this.getInputIocFile(taskOptions);
        taskOptions.log.info('ioc file:', inputIocFile);
        const changed = await this.hasIocChanged(inputIocFile, touchFile);
        if (changed) {
            const scriptFile = await this.writeScriptTemplate(genDir);
            await fs.copy(inputIocFile, iocFile);
            await this.runSTM32CubeMX(taskOptions, genDir, scriptFile, component);
            await this.patchFiles(taskOptions, genDir);
            await this.writeTouchFile(touchFile);
        }
        return this.addInfoFromMakefile(taskOptions.projectOptions, component, armGccComponent, genDir);
    }

    private async writeTouchFile(touchFile: string): Promise<void> {
        return fs.writeFile(touchFile, new Date().toString());
    }

    private async runSTM32CubeMX(
        taskOptions: TaskOptions,
        genDir: string,
        scriptFile: string,
        component: STM32CubeMXComponentOptions
    ): Promise<void> {
        return this.shell(taskOptions, [component.stm32cubemx || 'stm32cubemx', '-q', scriptFile], {
            cwd: genDir
        });
    }

    private async writeScriptTemplate(genDir: string) {
        const templateFile = path.join(__dirname, '../stm32cubemx-gen.script.ejs');
        const content = await fs.readFile(templateFile, 'utf8');
        const template = ejs.compile(content);
        const renderedContent = template({
            dir: path.resolve(genDir)
        });
        const fileName = path.resolve(genDir, 'stm32cubemx.script');
        await fs.writeFile(fileName, renderedContent);
        return fileName;
    }

    private async getInputIocFile(taskOptions: TaskOptions): Promise<string> {
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const inputIocFile = component.iocFile;
        if (inputIocFile) {
            return inputIocFile;
        }
        let projectDir = taskOptions.projectOptions.projectDir;
        let results = await glob('**/*.ioc', {
            cwd: projectDir,
            follow: true,
            ignore: ['node_modules/**', path.join(taskOptions.projectOptions.buildDir, '**')]
        });
        results = results.filter(r => {
            return !r.startsWith(taskOptions.projectOptions.buildDir);
        });
        if (results.length === 0) {
            throw new Error('Could not find .ioc file in project directories');
        }
        if (results.length > 1) {
            throw new Error(`Found too many .ioc file in project directories ${results}`);
        }
        return path.join(projectDir, results[0]);
    }

    private async hasIocChanged(inputIocFile: any, touchFile: string): Promise<boolean> {
        try {
            const inputIocFileStats = (await fs.stat(inputIocFile)).mtimeMs;
            const outputIocFileStats = (await fs.stat(touchFile)).mtimeMs;
            return inputIocFileStats > outputIocFileStats;
        } catch (err) {
            return true;
        }
    }

    private async patchFiles(taskOptions: TaskOptions, genDir: string): Promise<void> {
        await this.patchMainC(taskOptions, genDir);
        await this.patchHFiles(taskOptions, genDir);
    }

    private async patchMainC(taskOptions: TaskOptions, genDir: string) {
        await this.shell(taskOptions, ['dos2unix', path.resolve(genDir, 'Src/main.c')]);
        return this.shell(taskOptions, ['patch', '-N', path.resolve(genDir, 'Src/main.c'), path.resolve(__dirname, '../stm32cubemx-gen.patch')]);
    }

    private async patchHFiles(taskOptions: TaskOptions, genDir: string) {
        let cwd = path.resolve(genDir, 'Drivers/CMSIS/Device/ST');
        const hFiles = await glob('**/*.h', {cwd: cwd, follow: true})
        return Promise.all(hFiles.map(hFile => {
            return this.patchHFile(taskOptions, path.resolve(cwd, hFile));
        }));
    }

    private async patchHFile(taskOptions: TaskOptions, hFile: string) {
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const flashStart = component.flashStart || 0x08000000;
        const eePromStart = component.eePromStart || 0x08080000;
        let contents: string = await fs.readFile(hFile, 'utf8')
        contents = contents.replace(/^#define(\s+?)FLASH_BASE\s+.*$/gm, `#define FLASH_BASE ((uint32_t)0x${flashStart.toString(16)})`);
        contents = contents.replace(/^#define(\s+?)DATA_EEPROM_BASE\s+.*$/gm, `#define DATA_EEPROM_BASE ((uint32_t)0x${eePromStart.toString(16)})`);
        return fs.writeFile(hFile, contents);
    }

    private async addInfoFromMakefile(
        projectOptions: ProjectOptions,
        component: STM32CubeMXComponentOptions,
        armGccComponent,
        genDir: string
    ): Promise<void> {
        const sourceFiles = new Set();
        const includeDirs = new Set();
        const compilerOptions = new Set();
        const linkerOptions = new Set();
        const makefile = path.resolve(genDir, 'Makefile');
        let ldFile;
        const makefileContent = await fs.readFile(makefile, 'utf8');
        const vars = MakefileParser.parse(makefileContent);
        addAllToSet(sourceFiles, MakefileParser.stringToArray(vars['C_SOURCES']));
        addAllToSet(sourceFiles, MakefileParser.stringToArray(vars['ASM_SOURCES']));
        addAllToSet(
            includeDirs,
            MakefileParser.stringToArray(vars['C_INCLUDES'])
                .map(i => i.substr('-I'.length))
                .map(i => path.resolve(genDir, i))
        );
        addAllToSet(compilerOptions, MakefileParser.stringToArray(vars['C_DEFS']));
        addAllToSet(compilerOptions, MakefileParser.stringToArray(MakefileParser.resolve(vars, vars['MCU'])));
        addAllToSet(
            linkerOptions,
            MakefileParser.stringToArray(MakefileParser.resolve(vars, vars['LDFLAGS']))
                .map(f => {
                    const m = f.trim().match(/^-T(.*?\.ld)$/);
                    if (m) {
                        ldFile = path.join(genDir, m[1]);
                        f = `-T${ldFile}`
                    }
                    return f;
                })
                .filter(f => {
                    // TODO refactor to menuconfig
                    if (f === '-lnosys') {
                        return false;
                    }
                    return true;
                })
        );

        Array.prototype.push.apply(
            component.sourceFiles,
            Array.from(sourceFiles)
                .map(sourceFile => {
                    const filePathWithoutExt = path.basename(sourceFile, path.extname(sourceFile));
                    return {
                        filePath: path.resolve(genDir, sourceFile),
                        outputPath: path.join(projectOptions.buildDir, COMPONENT_NAME, filePathWithoutExt) + '.o',
                        depPath: path.join(projectOptions.buildDir, COMPONENT_NAME, filePathWithoutExt) + '.d',
                    };
                })
        );
        Array.prototype.push.apply(component.includeDirs, Array.from(includeDirs));
        Array.prototype.push.apply(component.compilerOptions, Array.from(compilerOptions));
        Array.prototype.push.apply(component.linkerOptions, Array.from(linkerOptions));

        if (ldFile) {
            // TODO patch ld file with flash start, ram start, and eeprom start values
            // LINK_FLASH_START       ?= 0x08000000
            // LINK_RAM_START         ?= 0x20000000
            // LINK_DATA_EEPROM_START ?= 0x08080000
            // MEMORY
            // {
            //     FLASH (rx)      : ORIGIN = $(LINK_FLASH_START), LENGTH = $(LINK_FLASH_LENGTH)
            //     RAM (xrw)       : ORIGIN = $(LINK_RAM_START), LENGTH = $(LINK_RAM_LENGTH)
            // }
            const ldFileContents = await fs.readFile(ldFile, 'utf8');
            let m = ldFileContents.match(/^RAM.*LENGTH = (.*?)K$/m);
            if (m) {
                armGccComponent.ram = parseInt(m[1]) * 1024;
            }

            m = ldFileContents.match(/^FLASH.*LENGTH = (.*?)K$/m);
            if (m) {
                armGccComponent.flash = parseInt(m[1]) * 1024;
            }
        }
    }
}

function addAllToSet(set: Set<any>, values: string[]) {
    for (const value of values) {
        set.add(value);
    }
}
