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

    run(taskOptions: TaskOptions): Promise<void> {
        const genDir: string = path.join(taskOptions.projectOptions.buildDir, 'stm32cubemx', 'gen');
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const armGccComponent = taskOptions.projectOptions.components['arm-gcc'] || {};
        const iocFile = path.join(genDir, 'stm32cubemx.ioc');
        const touchFile = path.join(genDir, 'stm32cubemxgen');
        return Promise.all([
            fs.mkdirs(genDir),
            this.getInputIocFile(taskOptions)
        ])
            .then((results) => {
                const inputIocFile = results[1];
                taskOptions.log.info('ioc file:', inputIocFile);
                return this.hasIocChanged(inputIocFile, touchFile)
                    .then(changed => {
                        if (!changed) {
                            return Promise.resolve();
                        }
                        return Promise.all([
                            this.writeScriptTemplate(genDir),
                            fs.copy(inputIocFile, iocFile)
                        ])
                            .then((results) => {
                                const scriptFile = results[0];
                                return this.runSTM32CubeMX(taskOptions, genDir, scriptFile, component);
                            })
                            .then(() => {
                                return this.patchFiles(taskOptions, genDir);
                            })
                            .then(() => {
                                return this.writeTouchFile(touchFile);
                            });
                    })
                    .then(() => {
                        return this.addInfoFromMakefile(taskOptions.projectOptions, component, armGccComponent, genDir);
                    });
            });
    }

    private writeTouchFile(touchFile: string) {
        return fs.writeFile(touchFile, new Date().toString());
    }

    private runSTM32CubeMX(
        taskOptions: TaskOptions,
        genDir: string,
        scriptFile: string,
        component: STM32CubeMXComponentOptions
    ): Promise<void> {
        return this.shell(taskOptions, [component.stm32cubemx || 'stm32cubemx', '-q', scriptFile], {
            cwd: genDir
        });
    }

    private writeScriptTemplate(genDir: string) {
        const templateFile = path.join(__dirname, '../stm32cubemx-gen.script.ejs');
        return fs.readFile(templateFile, 'utf8')
            .then(content => {
                const template = ejs.compile(content);
                const renderedContent = template({
                    dir: path.resolve(genDir)
                });
                const fileName = path.resolve(genDir, 'stm32cubemx.script');
                return fs.writeFile(fileName, renderedContent)
                    .then(() => {
                        return fileName;
                    });
            });
    }

    private getInputIocFile(taskOptions: TaskOptions): Promise<string> {
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const inputIocFile = component.iocFile;
        if (inputIocFile) {
            return Promise.resolve(inputIocFile);
        }
        let projectDir = taskOptions.projectOptions.projectDir;
        return glob('**/*.ioc', {
            cwd: projectDir,
            follow: true,
            ignore: ['node_modules/**', path.join(taskOptions.projectOptions.buildDir, '**')]
        })
            .then(results => {
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
            });
    }

    private hasIocChanged(inputIocFile: any, touchFile: string): Promise<boolean> {
        return Promise.all([
            fs.stat(inputIocFile),
            fs.stat(touchFile)
        ]).then(results => {
            const inputIocFileStats = results[0].mtimeMs;
            const outputIocFileStats = results[1].mtimeMs;
            return inputIocFileStats > outputIocFileStats;
        }).catch(err => {
            return true;
        });
    }

    private patchFiles(taskOptions: TaskOptions, genDir: string): Promise<void> {
        return Promise.all([
            this.patchMainC(taskOptions, genDir),
            this.patchHFiles(taskOptions, genDir)
        ]).then(() => {

        });
    }

    private patchMainC(taskOptions: TaskOptions, genDir: string) {
        return this.shell(taskOptions, ['dos2unix', path.resolve(genDir, 'Src/main.c')])
            .then(() => {
                return this.shell(taskOptions, ['patch', '-N', path.resolve(genDir, 'Src/main.c'), path.resolve(__dirname, '../stm32cubemx-gen.patch')]);
            });
    }

    private patchHFiles(taskOptions: TaskOptions, genDir: string) {
        let cwd = path.resolve(genDir, 'Drivers/CMSIS/Device/ST');
        return glob('**/*.h', {cwd: cwd, follow: true})
            .then(hFiles => {
                return Promise.all(hFiles.map(hFile => {
                    return this.patchHFile(taskOptions, path.resolve(cwd, hFile));
                }));
            });
    }

    private patchHFile(taskOptions: TaskOptions, hFile: string) {
        const component: STM32CubeMXComponentOptions = taskOptions.projectOptions.components[COMPONENT_NAME];
        const flashStart = component.flashStart || 0x08000000;
        const eePromStart = component.eePromStart || 0x08080000;
        return fs.readFile(hFile, 'utf8')
            .then((contents: string) => {
                contents = contents.replace(/^#define(\s+?)FLASH_BASE\s+.*$/gm, `#define FLASH_BASE ((uint32_t)0x${flashStart.toString(16)})`);
                contents = contents.replace(/^#define(\s+?)DATA_EEPROM_BASE\s+.*$/gm, `#define DATA_EEPROM_BASE ((uint32_t)0x${eePromStart.toString(16)})`);
                return fs.writeFile(hFile, contents);
            })
    }

    private addInfoFromMakefile(
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
        return fs.readFile(makefile, 'utf8')
            .then(makefileContent => {
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
                    return fs.readFile(ldFile, 'utf8')
                        .then(ldFileContents => {
                            let m = ldFileContents.match(/^RAM.*LENGTH = (.*?)K$/m);
                            if (m) {
                                armGccComponent.ram = parseInt(m[1]) * 1024;
                            }

                            m = ldFileContents.match(/^FLASH.*LENGTH = (.*?)K$/m);
                            if (m) {
                                armGccComponent.flash = parseInt(m[1]) * 1024;
                            }
                        });
                }
            });
    }
}

function addAllToSet(set: Set<any>, values: string[]) {
    for (const value of values) {
        set.add(value);
    }
}
