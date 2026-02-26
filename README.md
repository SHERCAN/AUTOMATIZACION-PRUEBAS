# Proyecto de Procesamiento de Archivos

Este proyecto está diseñado para procesar archivos de diferentes tipos.

## Estructura de Carpetas

La carpeta `procesamiento` es el lugar donde se deben colocar los archivos para ser procesados. Dentro de esta carpeta, existen subcarpetas para organizar los archivos por tipo de procesamiento.

## Formato de Archivos

Es importante tener en cuenta que los archivos que se coloquen dentro de las subcarpetas de `procesamiento` deben estar en formato **JSON** o **XML** para que puedan ser procesados correctamente.

Por favor, asegúrese de que los archivos cumplan con este requisito antes de colocarlos en las carpetas correspondientes.
### concurrencia
La configuración de concurrencia permite definir cuales archivos se procesarán simultáneamente, cada numero en concurrencia dara como objetivo un grupo que se enviara de manera simultanea, esto es el archivo .yml
```
apis:
  na1:
    concurrencia: 1  # Grupo 1
  na2:
    concurrencia: 1  # Grupo 1 (se ejecuta al mismo tiempo que na1)
  na3:
    concurrencia: 2  # Grupo 2 (espera a que termine grupo 1)
  na4:
    concurrencia: 2  # Grupo 2 (se ejecuta al mismo tiempo que na3)
  na5:
    concurrencia: 3  # Grupo 3 (espera a que terminen grupos 1 y 2)
```


### Archivos
```
- procesamiento
    - fevrips
        - rips.json
        - rips.xml
    - consultar
        - consultar.json
    - na1
        - na1.json
    ...
```
```
apis:
  fevrips:
    endpoint: "/api/PaquetesFevRips/CargarFevRips"
    carpeta_archivos: "./procesamiento/fevrips"
    comprimir: false
    concurrencia: 1
    repeticiones: 1   # Numero de repeticiones que se haran de los archivos, esto es concurrente
```
